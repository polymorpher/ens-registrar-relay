const express = require('express')
const router = express.Router()
const { StatusCodes } = require('http-status-codes')
const { Logger } = require('../logger')
const { body, validationResult } = require('express-validator')
const rateLimit = require('express-rate-limit')
const appConfig = require('../config')
const { getDomainRegistrationEvent, getSubdomains, nameExpires, utils: w3utils } = require('../src/w3utils')
const { v1: uuid } = require('uuid')
const { Purchase } = require('../src/data/purchase')
const domainApiProvider = appConfig.registrarProvider === 'enom' ? require('../src/enom-api') : require('../src/namecheap-api')
// const requestIp = require('request-ip')
// const { createNewCertificate } = require('../src/gcp-certs')
const { createNewCertificate, renewCertificate } = require('../src/letsencrypt-certs')
const { enableSubdomains, getWildcardSubdomainRecord } = require('../src/subdomains')
const { getCertificate, getCertificateMapEntry, parseCertId } = require('../src/gcp-certs')
const { schedule, lookup, lookupByJobId } = require('../src/cert-scheduler')
const { nameUtils } = require('./util')
const axios = require('axios')
const limiter = (args) => rateLimit({
  windowMs: 1000 * 60,
  max: 60,
  keyGenerator: req => req.fingerprint?.hash || '',
  ...args,
})

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
    if (crm) {
      const [, suffix] = parseCertId(crm.certificates[0])
      const cr = await getCertificate({ sld, suffix })
      if (cr) {
        return res.json({ error: 'certificate already exists', sld })
      }
    }
    try {
      if (!async) {
        await createNewCertificate({ sld })
        res.json({ success: true, sld })
        return
      }
      const nakedJobId = schedule({ sld, wc: false })
      const wcJobId = schedule({ sld, wc: true })
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
    const { domain, address } = req.body
    console.log('[/renew-cert]', { domain, address })
    const sld = domain.split('.country')[0]
    const expires = await nameExpires(sld)
    const now = Date.now()
    if (expires < now + 3600 * 1000 * 24 * 30) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'domain expired or expiring within 30 days', expires })
    }
    const crm = await getCertificateMapEntry({ sld })
    if (!crm) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'domain certificate does not exist, try calling [/cert] first' })
    }
    const [, suffix] = parseCertId(crm.certificates[0])
    const cert = await getCertificate({ sld, suffix })
    if (now + 3600 * 1000 * 24 * 30 < cert.expireTime.seconds * 1000) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'cert not expiring in the next 30 days', certExpires: cert.expireTime.seconds * 1000 })
    }
    try {
      await renewCertificate({ sld })
    } catch (ex) {
      console.error('[/renew-cert][error]', ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'certificate generation failed, please try again later' })
    }
  }

)
// very primitive locking mechanism
const purchasePending = {}
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
    const rid = uuid()
    try {
      const { name } = await checkEvent({ txHash, domain, address, res })
      if (!name) {
        return
      }
      const ip = undefined // requestIp.getClientIp(req)
      if (purchasePending[domain]) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'another purchase is pending'
        })
      }
      purchasePending[domain] = rid
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
          return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'purchase failed',
            domain: name,
            responseText
          })
        }
      }
      let certId, certMapId, dnsAuthId
      if (!fast) {
        ({ certId, certMapId, dnsAuthId } = await createNewCertificate({ sld: name }))
      }
      const p = await Purchase.addNew({
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
      Logger.log('[/purchase]', p)
      res.json({ success, domainCreationDate, domainExpiryDate, responseText, traceId, reqTime })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    } finally {
      if (purchasePending[domain] === rid) {
        delete purchasePending[domain]
      }
    }
  })

if (appConfig.allowAdminOverride) {
  router.post('/purchase-mock', async (req, res) => {
    const ip = undefined // requestIp.getClientIp(req)
    const { domain, address } = req.body
    const name = domain.split('.')[0]
    const { success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime } =
      await domainApiProvider.purchaseDomain({ sld: name, ip })
    const p = await Purchase.addNew({
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
    if (!success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'purchase failed', domain: name, responseText })
    }
    res.json({ success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime })
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

router.post('/enable-subdomains',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain } = req.body
    console.log('[/enable-subdomains]', { domain })
    const sld = domain.split('.country')[0]
    try {
      const subdomains = await getSubdomains(sld)
      if (subdomains.length === 0) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'no subdomain enabled' })
      }
      if (await getWildcardSubdomainRecord({ sld })) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'already enabled' })
      }
      await enableSubdomains({ sld })
      res.json({ success: true })
    } catch (ex) {
      if (ex.response) {
        console.error(ex.response.code, ex.response.data)
      } else {
        console.error(ex)
      }
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })
module.exports = router
