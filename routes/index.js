const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const { StatusCodes } = require('http-status-codes')
const { Logger } = require('../logger')
const { body, validationResult } = require('express-validator')
const rateLimit = require('express-rate-limit')
const appConfig = require('../config')
const { getDomainRegistrationEvent, nameExpires, utils: w3utils } = require('../src/w3utils')
const { v1: uuid } = require('uuid')
const { Purchase } = require('../src/data/purchase')
const domainApiProvider = appConfig.registrarProvider === 'enom' ? require('../src/enom-api') : require('../src/namecheap-api')
// const requestIp = require('request-ip')
// const { createNewCertificate } = require('../src/gcp-certs')
const { createNewCertificate, renewCertificate } = require('../src/letsencrypt-certs')
const { getCertificate, getCertificateMapEntry, parseCertId } = require('../src/gcp-certs')
const { schedule, lookup, lookupByJobId } = require('../src/cert-scheduler')
const { nameUtils } = require('./util')
const axios = require('axios')
const { domainInfo, renewDomain } = require('../src/namecheap-api')
const { Renewal } = require('../src/data/renewal')
const limiter = (args) => rateLimit({
  windowMs: 1000 * 60,
  max: 60,
  keyGenerator: req => req.fingerprint?.hash || '',
  ...args,
})

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

// Accepts `Authorization: Bearer <key>` or a bare `Authorization: <key>`
const requireAdminApiKey = (req, res, next) => {
  const keys = appConfig.adminDomainApiKeys
  if (keys.length === 0) {
    console.error('[admin] request rejected: ADMIN_DOMAIN_API_KEYS is not configured')
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'unauthorized' })
  }
  const key = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!key || !keys.some(k => safeEqual(k, key))) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'unauthorized' })
  }
  next()
}

router.get('/health', async (req, res) => {
  Logger.log('[/health]', req.fingerprint)
  res.send('OK').end()
})

router.post('/check-domain', limiter(), async (req, res) => {
  const { sld } = req.body
  console.log('[/check-domain]', { sld })
  const ip = undefined // requestIp.getClientIp(req)
  if (!sld) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'missing fields', sld })
  }
  try {
    const { isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, restorePrice, responseText } =
      await domainApiProvider.checkIsDomainAvailable({ sld, ip })
    res.json({ isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, restorePrice, responseText })
  } catch (ex) {
    console.error('[/check-domain]', { sld })
    console.error(ex)
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'cannot process request' })
  }
})

const checkEvent = async ({ txHash, domain, address, res }) => {
  const event = await getDomainRegistrationEvent(txHash)
  if (!event) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'did not find registration event in txHash', txHash })
    return {}
  }
  const { name, owner, expires } = event
  if (owner.toLowerCase() !== address.toLowerCase()) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'registration event owner mismatch',
      eventAddress: owner,
      providedAddress: address
    })
    return {}
  }
  if (`${name}.${appConfig.tld}` !== domain) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'registration event domain mismatch',
      eventDomain: `${name}.${appConfig.tld}`,
      providedDomain: domain
    })
    return {}
  }
  const now = Date.now()
  const latestAllowedTime = parseInt(expires) * 1000
  if (now > latestAllowedTime) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'registration was too old',
      latestAllowedTime,
      now
    })
    return {}
  }
  return { name, expires }
}
router.post('/cert',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, address, async } = req.body
    console.log('[/cert]', { domain, address, async })
    const sld = domain.split('.country')[0]
    const expiry = await nameExpires(sld)
    if (expiry <= Date.now()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain expired', domain })
    }
    const crm = await getCertificateMapEntry({ sld })
    const crmWc = await getCertificateMapEntry({ sld, wc: true })
    const wcOnly = crm && !crmWc
    if (crm && crmWc) {
      const [, , idOverride] = parseCertId(crm.certificates[0])
      const cr = await getCertificate({ idOverride })
      const [, , idOverrideWcCert] = parseCertId(crmWc.certificates[0])
      const crWc = await getCertificate({ idOverride: idOverrideWcCert })
      if (cr && crWc) {
        return res.json({ error: 'certificate already exists', sld })
      }
    }
    try {
      if (!async) {
        await createNewCertificate({ sld, wcOnly })
        res.json({ success: true, sld, wcOnly })
        return
      }
      let nakedJobId
      if (!wcOnly) {
        nakedJobId = await schedule({ sld, wc: false })
      }
      const wcJobId = await schedule({ sld, wc: true })
      return res.json({ success: true, wcJobId, nakedJobId, sld })
    } catch (ex) {
      console.error('[/cert][error]', ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'certificate generation failed, please try again later' })
    }
  })

router.post('/cert-job-lookup',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).optional().trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  body('jobId').isUUID(1).optional(),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, jobId } = req.body
    if (!domain && !jobId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'at least one must be provided: domain, jobId', domain, jobId })
    }
    console.log('[/cert-job-lookup]', { domain, jobId })
    const sld = domain.split('.country')[0]
    if (jobId) {
      const job = await lookupByJobId({ jobId })
      return res.json(job)
    }
    const jobs = await lookup({ sld })
    return res.json(jobs)
  })

router.post('/renew-cert',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, async } = req.body
    console.log('[/renew-cert]', { domain })
    const sld = domain.split('.country')[0]
    const expires = await nameExpires(sld)
    const now = Date.now()
    if (expires < now + 3600 * 1000 * 24 * 3) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'domain expired or expiring within 3 days', expires })
    }
    const crm = await getCertificateMapEntry({ sld })
    if (!crm) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'domain certificate does not exist, try calling [/cert] first' })
    }
    const [, suffix] = parseCertId(crm.certificates[0])
    const cert = await getCertificate({ sld, suffix })
    if (cert && (now + 3600 * 1000 * 24 * 30 < (cert?.expireTime?.seconds || 0) * 1000)) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'cert not expiring in the next 30 days', certExpires: cert.expireTime.seconds * 1000 })
    }
    try {
      if (!async) {
        await renewCertificate({ sld })
        res.json({ success: true, sld })
        return
      }
      const nakedJobId = await schedule({ sld, wc: false, renew: true })
      const wcJobId = await schedule({ sld, wc: true, renew: true })
      return res.json({ success: true, wcJobId, nakedJobId, sld })
    } catch (ex) {
      console.error('[/renew-cert][error]', ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'certificate generation failed, please try again later' })
    }
  }

)
// very primitive locking mechanism
const purchasePending = {}

// Registrar purchase, certificate issuance and record keeping. Contains no blockchain interaction, so it is shared by
// /purchase (which verifies the on-chain registration event first) and /admin/purchase (which does not).
const executePurchase = async ({ domain, name, address, fast, res, tag }) => {
  if (purchasePending[domain]) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'another purchase is pending'
    })
  }
  const rid = uuid()
  purchasePending[domain] = rid
  try {
    const ip = undefined // requestIp.getClientIp(req)
    let success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime
    const reserved = nameUtils.isReservedName(name)
    if (!reserved) {
      const { isAvailable, ...checkResponseArgs } = await domainApiProvider.checkIsDomainAvailable({ sld: name })
      if (!isAvailable) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain not available', ...checkResponseArgs })
      }
      ({
        success,
        pricePaid,
        orderId,
        domainCreationDate,
        domainExpiryDate,
        responseCode,
        responseText,
        traceId,
        reqTime
      } = await domainApiProvider.purchaseDomain({ sld: name, ip }))
      if (!success) {
        console.error(`[${tag}][registrar-failure]`, { domain: name, responseCode, responseText })
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
          error: 'purchase failed',
          domain: name,
          responseCode,
          responseText
        })
      }
    }
    let certId, certMapId, dnsAuthId
    if (!fast) {
      ({ certId, certMapId, dnsAuthId } = await createNewCertificate({ sld: name }))
    }
    const p = await Purchase.upsertNew({
      domain,
      address,
      reserved,
      pricePaid,
      orderId,
      domainCreationDate,
      domainExpiryDate,
      responseCode,
      responseText,
      traceId,
      reqTime,
      certId,
      certMapId,
      dnsAuthId
    })
    Logger.log(`[${tag}]`, p)
    res.json({ success, domainCreationDate, domainExpiryDate, responseText, traceId, reqTime })
  } finally {
    if (purchasePending[domain] === rid) {
      delete purchasePending[domain]
    }
  }
}

router.post('/purchase',
  limiter(),
  body('txHash').isLength({ min: 66, max: 66 }).trim().matches(/0x[a-fA-F0-9]+/),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  body('address').isLength({ min: 42, max: 42 }).trim().matches(/0x[a-fA-F0-9]+/),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { txHash, domain, address, fast } = req.body
    console.log('[/purchase]', { txHash, domain, address, fast })
    try {
      const { name } = await checkEvent({ txHash, domain, address, res })
      if (!name) {
        return
      }
      await executePurchase({ domain, name, address, fast, res, tag: '/purchase' })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })

// Force-registers a domain at the registrar without any blockchain verification. Requires an admin API key.
router.post('/admin/purchase',
  limiter(),
  requireAdminApiKey,
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`^[a-z0-9-]+\\.${appConfig.tld}$`),
  body('address').optional({ nullable: true, checkFalsy: true }).isLength({ min: 42, max: 42 }).trim().matches(/^0x[a-fA-F0-9]+$/),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, address, fast } = req.body
    console.log('[/admin/purchase]', { domain, address, fast })
    try {
      const name = domain.split('.')[0]
      await executePurchase({ domain, name, address: address || undefined, fast, res, tag: '/admin/purchase' })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })

if (appConfig.allowAdminOverride) {
  router.post('/purchase-mock', async (req, res) => {
    const { domain, address } = req.body
    if (!domain || !address) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'missing fields', domain, address })
    }
    const name = domain.split('.')[0]
    const ip = undefined // requestIp.getClientIp(req)
    try {
      const { success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime } =
        await domainApiProvider.purchaseDomain({ sld: name, ip })
      if (!success) {
        console.error('[/purchase-mock][registrar-failure]', { domain: name, responseCode, responseText })
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'purchase failed', domain: name, responseCode, responseText })
      }
      const p = await Purchase.upsertNew({
        domain,
        address,
        pricePaid,
        orderId,
        domainCreationDate,
        domainExpiryDate,
        responseCode,
        responseText,
        traceId,
        reqTime
      })
      Logger.log('[/purchase]', p)
      res.json({ success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })
}

router.post('/gen',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain } = req.body
    console.log('[/gen]', { domain })
    const name = domain.split('.country')[0]
    const expiry = await nameExpires(name)
    if (expiry <= Date.now()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain expired', domain })
    }
    const id = BigInt(w3utils.keccak256(name, true)).toString()
    const id2 = BigInt(w3utils.hexString(w3utils.namehash(domain))).toString()
    const path721 = `https://storage.googleapis.com/${appConfig.generator.metadataBucket}/erc721/${id}`
    const path1155 = `https://storage.googleapis.com/${appConfig.generator.metadataBucket}/erc1155/${id2}`
    try {
      console.log(`[/gen] Checking ${path721}`)
      console.log(`[/gen] Checking ${path1155}`)
      await axios.get(path721)
      await axios.get(path1155)
      return res.json({
        generated: false,
        error: 'already exists',
        metadata: {
          erc721Metadata: path721,
          erc1155Metadata: path1155,
        }
      })
    } catch (ex) {
      console.log(`[/gen] Did not find ${name}; generating...`)
    }
    try {
      const { data } = await axios.get(appConfig.generator.apiBase + '/generate-nft-data', {
        params: {
          domain,
          registrationTs: Date.now(),
          expirationTs: expiry
        }
      })
      const { metadata } = data || {}
      res.json({ generated: true, metadata })
    } catch (ex) {
      if (ex.response) {
        console.error(ex.response.code, ex.response.data)
      } else {
        console.error(ex)
      }
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  }
)

router.post('/renew-metadata',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain } = req.body
    console.log('[/renew-metadata]', { domain })
    const name = domain.split('.country')[0]
    const expiry = await nameExpires(name)
    if (expiry <= Date.now()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain expired', domain })
    }
    const id = BigInt(w3utils.keccak256(name, true)).toString()
    const id2 = BigInt(w3utils.hexString(w3utils.namehash(domain))).toString()
    const path721 = `https://storage.googleapis.com/${appConfig.generator.metadataBucket}/erc721/${id}`
    const path1155 = `https://storage.googleapis.com/${appConfig.generator.metadataBucket}/erc1155/${id2}`
    try {
      console.log(`[/renew-metadata] Checking ${path721}`)
      console.log(`[/renew-metadata] Checking ${path1155}`)
      const { data: data1 } = await axios.get(path721)
      const { data: data2 } = await axios.get(path1155)
      const metadataExpiry1 = Number((data1.attributes || [])?.find(attr => attr.trait_type === 'Expiration Date')?.value || 0)
      const metadataExpiry2 = Number((data2.attributes || [])?.find(attr => attr.trait_type === 'Expiration Date')?.value || 0)
      if (metadataExpiry1 && metadataExpiry2 && metadataExpiry1 === metadataExpiry2 && metadataExpiry1 === expiry) {
        return res.json({
          renewed: false,
          error: 'metadata already renewed',
          metadata: {
            erc721Metadata: path721,
            erc1155Metadata: path1155,
          }
        })
      }
    } catch (ex) {
      console.error('[/renew-metadata]', ex)
      return res.status(StatusCodes.NOT_FOUND).json({
        renewed: false,
        error: 'cannot find metadata file or appropriate data',
        metadata: {
          erc721Metadata: path721,
          erc1155Metadata: path1155,
        }
      })
    }
    const renewalTs = Date.now()
    try {
      const { data } = await axios.get(appConfig.generator.apiBase + '/renew', {
        params: {
          domain,
          renewalTs,
          expirationTs: expiry
        }
      })
      const { metadata } = data || {}
      res.json({ renewed: true, metadata, expiry })
    } catch (ex) {
      if (ex.response) {
        console.error(ex.response.code, ex.response.data)
      } else {
        console.error(ex)
      }
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  }
)

// Registrar renewal and record keeping, given the registrar's current info for the domain. Contains no blockchain
// interaction, so it is shared by /renew (which checks on-chain expiry first) and /admin/renew (which does not).
const executeRenewal = async ({ domain, sld, info, res, tag }) => {
  const { expiryTime, createTime, isOwner, error, responseCode: errorResponseCode } = info
  if (!isOwner) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'domain is not owned by dot-country'
    })
  }
  if (error) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error, errorResponseCode,
    })
  }
  const { success, pricePaid, orderId, responseCode, responseText, traceId } = await renewDomain({ sld })
  const p = await Renewal.upsertNew({
    domain,
    pricePaid,
    orderId,
    domainCreationTime: createTime,
    domainExpiryTime: expiryTime,
    duration: 1,
    responseCode,
    responseText,
    traceId,
  })
  Logger.log(`[${tag}]`, p)
  res.json({ success, domainCreationTime: createTime, domainExpiryTime: expiryTime, duration: 1, responseText, traceId })
}

router.post('/renew',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, fast } = req.body
    console.log('[/renew]', { domain, fast })
    try {
      const sld = domain.split('.')[0]
      const expiry = await nameExpires(sld)
      if (!(expiry > Date.now())) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'domain is expired on blockchain',
          expiry
        })
      }
      const info = await domainInfo({ sld })
      if (!(expiry > info.expiryTime)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'domain expires first on blockchain. Must renew on-chain first to beyond web2 expiry time',
          expiry,
          web2Expiry: info.expiryTime
        })
      }
      await executeRenewal({ domain, sld, info, res, tag: '/renew' })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })

// Force-renews a domain at the registrar without any blockchain verification. Requires an admin API key.
router.post('/admin/renew',
  limiter(),
  requireAdminApiKey,
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`^[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain } = req.body
    console.log('[/admin/renew]', { domain })
    try {
      const sld = domain.split('.')[0]
      const info = await domainInfo({ sld })
      await executeRenewal({ domain, sld, info, res, tag: '/admin/renew' })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })

module.exports = router
