const express = require('express')
const router = express.Router()
const { StatusCodes } = require('http-status-codes')
const { Logger } = require('../logger')
const { body, validationResult } = require('express-validator')
const rateLimit = require('express-rate-limit')
const appConfig = require('../config')
const axios = require('axios')
const { XMLParser } = require('fast-xml-parser')
const { getDomainRegistrationEvent } = require('../src/w3utils')
const { v1: uuid } = require('uuid')
const { Purchase } = require('../src/data/purchase')
const base = axios.create({
  baseURL: appConfig.enom.test ? 'https://resellertest.enom.com' : 'https://reseller.enom.com'
})

base.interceptors.request.use((config) => {
  // use config.params if it has been set
  config.params = config.params || {}
  // add any client instance specific params to config
  config.params.UID = appConfig.enom.uid
  config.params.PW = appConfig.enom.pw
  config.params.TLD = appConfig.tld
  config.params.responseType = 'xml'
  config.params.version = '2'
  return config
})

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

const checkIsDomainAvailable = async ({ sld }) => {
  const { data } = await base.get('/interface.asp', {
    params: {
      Command: 'check',
      SLD: sld,
      includeprice: '1',
      includeproperties: '1',
      includeeap: '1'
    }
  })
  const parser = new XMLParser()
  const parsed = parser.parse(data)['interface-response']
  console.log('[check-domain]', sld, JSON.stringify(parsed))
  const {
    Domains: {
      Domain: {
        RRPCode: responseCode,
        RRPText: responseText,
        IsPremium: isPremium,
        IsPlatinum: isPlatinum,
        IsEAP: isEap,
        Prices: {
          Registration: regPrice,
          Renewal: renewPrice,
          Transfer: transferPrice,
          Restore: restorePrice
        }
      }
    }
  } = parsed
  const isRegistered = parseInt(responseCode) !== 210
  const isReserved = (isPremium.toLowerCase() !== 'false' ||
    isPlatinum.toLowerCase() !== 'false' ||
    isEap.toLowerCase() !== 'false')
  const isAvailable = !isRegistered && !isReserved && regPrice < 50
  return { isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, restorePrice, responseText }
}

const purchaseDomain = async ({ sld }) => {
  const r = appConfig.enom.defaultRegistrant
  const { data } = await base.get('/interface.asp', {
    params: {
      Command: 'purchase',
      SLD: sld,
      NS1: appConfig.enom.ns1,
      NS2: appConfig.enom.ns2,
      RegistrantFirstName: r.RegistrantFirstName,
      RegistrantLastName: r.RegistrantLastName,
      RegistrantAddress1: r.RegistrantAddress1,
      RegistrantCity: r.RegistrantCity,
      RegistrantStateProvince: r.RegistrantStateProvince,
      RegistrantPostalCode: r.RegistrantPostalCode,
      RegistrantCountry: r.RegistrantCountry,
      RegistrantEmailAddress: r.RegistrantEmailAddress,
      RegistrantPhone: r.RegistrantPhone,
      RegistrantFax: r.RegistrantFax,
    }
  })
  const parser = new XMLParser()
  const parsed = parser.parse(data)['interface-response']
  console.log('[purchase-domain]', sld, JSON.stringify(parsed))
  const {
    TotalCharged: pricePaid,
    OrderID: orderId,
    DomainInfo: {
      RegistryCreateDate: domainCreationDate,
      RegistryExpDate: domainExpiryDate,
    },
    RRPCode: responseCode,
    RRPText: responseText,
    TrackingKey: traceId,
    RequestDateTime: reqTime,
  } = parsed
  const success = responseCode === 200
  return { success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime }
}

router.post('/check-domain', limiter(), async (req, res) => {
  const { sld } = req.body
  if (!sld) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'missing fields', sld })
  }
  try {
    const { isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, restorePrice, responseText } =
      await checkIsDomainAvailable({ sld })
    res.json({ isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, restorePrice, responseText })
  } catch (ex) {
    console.error('[/check-domain]', { sld })
    console.error(ex)
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'cannot process request' })
  }
})

// very primitive locking mechanism
const purchasePending = {}
router.post('/purchase',
  limiter(),
  body('txHash').isLength({ min: 66, max: 66 }).trim().matches(/0x[a-fA-F0-9]+/),
  body('domain').isLength({ min: 1, max: 20 }).trim().matches(/[a-zA-Z0-9-]+/),
  body('address').isLength({ min: 42, max: 42 }).trim().matches(/0x[a-fA-F0-9]+/),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }
    const { txHash, domain, address } = req.body
    const rid = uuid()
    try {
      const event = await getDomainRegistrationEvent(txHash)
      if (!event) {
        return res.status(StatusCodes.NOT_FOUND).json({ error: 'did not find registration event in txHash', txHash })
      }
      const { name, owner, baseCost, expires } = event
      if (owner.toLowerCase() !== address.toLowerCase()) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'registration event owner mismatch',
          eventAddress: owner,
          providedAddress: address
        })
      }
      if (`${name}.${appConfig.tld}` !== domain) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'registration event domain mismatch',
          eventDomain: `${name}.${appConfig.tld}`,
          providedDomain: domain
        })
      }
      const now = Date.now()
      const latestAllowedTime = parseInt(expires) - 365 * 3600 * 24 + 3600
      if (now > latestAllowedTime) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'registration was too old',
          latestAllowedTime,
          now
        })
      }
      if (purchasePending[domain]) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'another purchase is pending'
        })
      }
      purchasePending[domain] = rid
      const { isAvailable, ...checkResponseArgs } = await checkIsDomainAvailable({ sld: name })
      if (!isAvailable) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain not available', ...checkResponseArgs })
      }

      const { success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime } = await purchaseDomain({ sld: name })
      if (!success) {
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'purchase failed', domain: name, responseText })
      }
      const p = await Purchase.addNew({
        domain, address, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime
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
module.exports = router
