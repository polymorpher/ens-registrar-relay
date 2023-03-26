const express = require('express')
const router = express.Router()
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
const { createNewCertificate } = require('../src/letsencrypt-certs')
const { getCertificate } = require('../src/gcp-certs')
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
    const { txHash, domain, address } = req.body
    console.log('[/cert]', { txHash, domain, address })
    const name = domain.split('.country')[0]
    const expiry = await nameExpires(name)
    if (expiry <= Date.now()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain expired', domain })
    }
    const cr = await getCertificate({ sld: name })
    if (cr) {
      return res.json({ error: 'certificate already exists', sld: name })
    }
    try {
      await createNewCertificate({ sld: name })
      res.json({ success: true, sld: name })
    } catch (ex) {
      console.error('[/cert][error]', ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'certificate generation failed, please try again later' })
    }
  })
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

module.exports = router
