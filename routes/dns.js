const express = require('express')
const router = express.Router()
const { StatusCodes } = require('http-status-codes')
const { Logger } = require('../logger')
const { body, validationResult } = require('express-validator')
const appConfig = require('../config')
const { getWildcardSubdomainRecord, enableSubdomains, verifyMessage, setCname, verifyRedirect } = require('../src/subdomains')
const { nameExpires, getOwner } = require('../src/w3utils')
const { newInstance, redisClient } = require('../src/redis')
const { isMailEnabled, enableMail } = require('../src/mail')
const rateLimit = require('express-rate-limit')
const config = require('../config')

const limiter = (args) => rateLimit({
  windowMs: 1000 * 60,
  max: 240,
  keyGenerator: req => req.fingerprint?.hash || '',
  ...args,
})

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
      // const subdomains = await getSubdomains(sld)
      // if (subdomains.length === 0) {
      //   return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'no subdomain enabled' })
      // }
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

router.post('/enable-mail',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain } = req.body
    console.log('[/enable-mail]', { domain })
    const sld = domain.split('.country')[0]
    try {
      const expiry = await nameExpires(sld)
      if (expiry <= Date.now()) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain expired', domain })
      }
      if (await isMailEnabled({ sld })) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'mail already enabled', domain })
      }
      await enableMail({ sld })
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

router.post('/cname',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  body('subdomain').isLength({ min: 1, max: 32 }).trim().matches('^[@a-z0-9-]+$'),
  body('signature').isLength({ min: 132, max: 132 }).trim().matches('^0x[abcdefABCDEF0-9]+$'),
  body('deadline').isNumeric(),
  body('targetDomain').trim().matches('^[a-zA-Z0-9]+[a-zA-Z0-9-.]+[a-zA-Z0-9]+$'),
  body('deleteRecord').isBoolean().optional(),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, signature, subdomain, deadline, targetDomain, deleteRecord } = req.body
    console.log('[/cname]', { domain, signature, subdomain, deadline, targetDomain, deleteRecord })
    try {
      const sld = domain.split('.country')[0]
      const owner = await getOwner(sld)
      if (!(Date.now() / 1000 < deadline)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'deadline exceeded', deadline })
      }
      const valid = verifyMessage({ addresses: [owner, ...config.dns.maintainers], sld, signature, deleteRecord, subdomain, deadline, targetDomain })
      if (!valid) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'invalid signature', signature })
      }
      if (deleteRecord) {
        await setCname({ sld, targetDomain: '', subdomain })
        return res.json({ success: true, deleteRecord })
      }
      await setCname({ sld, targetDomain, subdomain })
      return res.json({ success: true })
    } catch (ex) {
      if (ex.response) {
        console.error(ex.response.code, ex.response.data)
      } else {
        console.error(ex)
      }
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })

let redirectRedis

if (config.redirect.redisUrl) {
  newInstance(config.redirect.redisUrl).then((client) => {
    redirectRedis = client
  }).catch(ex => {
    console.error(ex)
    process.exit(1)
  })
}

router.post('/redirect',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  body('subdomain').isLength({ min: 1, max: 32 }).trim().matches('^(@|[a-z0-9-]+)$'),
  body('path').custom((input) => {
    if (!input) {
      return false
    }
    input = input.toString()
    if (input.includes('?') || input.includes('#')) {
      return false
    }
    try {
      // eslint-disable-next-line no-new
      new URL(`https://google.com${input}`)
      return true
    } catch (ex) {
      console.error(ex)
      return false
    }
  }),
  body('signature').isLength({ min: 132, max: 132 }).trim().matches('^0x[abcdefABCDEF0-9]+$'),
  body('deadline').isNumeric(),
  body('target').trim().custom((input) => {
    try {
      // eslint-disable-next-line no-new
      new URL(input)
      return true
    } catch (ex) {
      console.error(ex)
      return false
    }
  }),
  body('deleteRecord').isBoolean().optional(),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, signature, subdomain, path, deadline, target, deleteRecord } = req.body
    console.log('[/redirect]', { domain, signature, subdomain, path, deadline, target, deleteRecord })
    try {
      const sld = domain.split('.country')[0]
      const owner = await getOwner(sld)
      if (!(Date.now() / 1000 < deadline)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'deadline exceeded', deadline })
      }
      const fqdn = subdomain === '@' ? domain : `${subdomain}.${domain}`
      // const fullUrl = path === '/' ? fqdn : `${fqdn}${path}`
      const fullUrl = `${fqdn}${path}`
      const valid = verifyRedirect({ addresses: [owner, ...config.dns.maintainers], fullUrl, signature, deleteRecord, deadline, target })
      if (!valid) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'invalid signature', signature })
      }
      const record = JSON.parse(await redisClient.hGet(`${domain}.`, subdomain) ?? '{}')
      if (subdomain === '@' && deleteRecord) {
        record.a = [{ ttl: 300, ip: config.dns.ip }]
      }
      if (subdomain === 'mail' && deleteRecord) {
        record.a = [{ ttl: 300, ip: config.easIp }]
      } else if (deleteRecord) {
        delete record.a
      } else {
        record.a = [{ ttl: 300, ip: config.redirect.serverIp }]
      }
      delete record.cname
      await redisClient.hSet(`${domain}.`, subdomain, JSON.stringify(record))

      let rrResponse
      if (deleteRecord) {
        rrResponse = await redirectRedis.del(fullUrl)
      } else {
        rrResponse = await redirectRedis.set(fullUrl, target)
      }
      Logger.log('[/redirect]', `RedirectRedis Response: ${rrResponse}`, `[${fullUrl}] to [${target}]`)
      res.json({ success: true })
    } catch (ex) {
      console.error(ex)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal error' })
    }
  })

module.exports = router
