const express = require('express')
const router = express.Router()
const { StatusCodes } = require('http-status-codes')
const { Logger } = require('../logger')
const rateLimit = require('express-rate-limit')
const { body, validationResult } = require('express-validator')
const appConfig = require('../config')
const { nameExpires } = require('../src/w3utils')
const { isOtcEnabled, enableOtc, checkOfferCreatedEvent } = require('../src/app/otc')

const limiter = (args) => rateLimit({
  windowMs: 1000 * 60,
  max: 240,
  keyGenerator: req => req.fingerprint?.hash || '',
  ...args,
})

router.post('/otc',
  limiter(),
  body('domain').isLength({ min: 1, max: 32 }).trim().matches(`[a-z0-9-]+\\.${appConfig.tld}$`),
  body('txHash').isLength({ min: 66, max: 66 }).trim().matches(/0x[a-fA-F0-9]+/),
  async (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() })
    }
    const { domain, txHash } = req.body
    Logger.log('[/app/otc]', { domain })
    try {
      const name = domain.split('.country')[0]
      const expiry = await nameExpires(name)
      const sld = domain.split('.country')[0]
      if (expiry <= Date.now()) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'domain expired', domain })
      }
      if (await isOtcEnabled({ sld })) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'mail already enabled', domain })
      }
      const proceed = await checkOfferCreatedEvent({ txHash, domain, res })
      if (!proceed) {
        return
      }
      await enableOtc({ sld })
      res.json({ success: true })
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
