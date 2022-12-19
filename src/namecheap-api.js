const axios = require('axios')
const appConfig = require('../config')
const { XMLParser } = require('fast-xml-parser')
const NodeCache = require('node-cache')
const cache = new NodeCache({ stdTTL: 600 })

const base = axios.create({
  baseURL: appConfig.enom.test ? 'https://api.sandbox.namecheap.com' : 'https://api.namecheap.com'
})

base.interceptors.request.use((config) => {
  // use config.params if it has been set
  config.params = config.params || {}
  // add any client instance specific params to config
  config.params.ApiUser = appConfig.namecheap.apiUser
  config.params.UserName = appConfig.namecheap.username
  config.params.ApiKey = appConfig.namecheap.apiKey
  return config
})

const checkTldPrice = async ({ ip = appConfig.namecheap.defaultIp, priceType = 'REGISTER' }) => {
  const cached = cache.get(`namecheap-tld-price-${priceType}`)
  if (cached) {
    return cached
  }
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.users.getPricing',
      ClientIp: ip,
      ProductType: 'DOMAIN',
      ActionName: priceType,
      ProductName: 'COUNTRY'
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  console.log('[checkTldPrice]', JSON.stringify(parsed))
  const options = parsed?.CommandResponse?.UserGetPricingResult?.ProductType?.ProductCategory?.Product?.Price || {}
  const {
    '@_Price': basePrice,
    '@_AdditionalCost': additionalCost,
    '@_RegularPrice': regularPrice,
  } = options[0]
  const price = parseFloat(basePrice) + parseFloat(additionalCost)
  const ret = { price, basePrice: parseFloat(basePrice), additionalCost: parseFloat(additionalCost), regularPrice: parseFloat(regularPrice) }
  cache.set(`namecheap-tld-price-${priceType}`, ret)
  return ret
}

const checkIsDomainAvailable = async ({ sld, ip = appConfig.namecheap.defaultIp }) => {
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.domains.check',
      DomainList: `${sld}.${appConfig.tld}`,
      ClientIp: ip,
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  const error = parsed?.Errors?.Error?.['#text']
  const responseCode = parseInt(parsed?.Errors?.Error?.['@_Number'] || '0')
  console.log('[checkIsDomainAvailable]', sld, JSON.stringify(parsed))
  const {
    CommandResponse: {
      DomainCheckResult: {
        '@_Available': responseAvailable,
        '@_Description': responseDesc,
        '@_IsPremiumName': isPremium,
        // These may be used later
        // '@_PremiumRegistrationPrice': premiumRegPrice,
        // '@_PremiumRenewalPrice': premiumRenewPrice,
        // '@_PremiumRestorePrice': premiumRestorePrice,
        // '@_PremiumTransferPrice': premiumTransferPrice,
        // '@_IcannFee': premiumIcannFee,
        // '@_EapFee': premiumEapFee,
      }
    }
  } = parsed
  const responseText = responseDesc || error
  const isRegistered = responseAvailable.toLowerCase() === 'true'
  const isReserved = isPremium.toLowerCase() === 'true'
  const isAvailable = !isRegistered && !isReserved
  const { price: regPrice } = await checkTldPrice({ ip })
  const { price: renewPrice } = await checkTldPrice({ ip, priceType: 'RENEW' })
  const { price: transferPrice } = await checkTldPrice({ ip, priceType: 'TRANSFER' })
  return { isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, responseText, responseCode }
}

const purchaseDomain = async ({ sld }) => {
  const r = appConfig.enom.defaultRegistrant
  const admin = appConfig.enom.defaultContact('Admin')
  const tech = appConfig.enom.defaultContact('Tech')
  const aux = appConfig.enom.defaultContact('AuxBilling')
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.domains.create',
      DomainName: `${sld}.${appConfig.tld}`,
      Years: '1',
      AddFreeWhoisguard: 'yes',
      WGEnabled: 'yes',
      Nameservers: `${appConfig.namecheap.ns1},${appConfig.namecheap.ns2}`,
      ...r,
      ...admin,
      ...tech,
      ...aux,
    }
  })
  const parser = new XMLParser()
  const parsed = parser.parse(data).ApiResponse
  const error = parsed?.Errors?.Error?.['#text']
  const responseCode = parseInt(parsed?.Errors?.Error?.['@_Number'] || '0')
  const result = parsed?.CommandResponse?.DomainCreateResult

  console.log('[purchaseDomain]', sld, JSON.stringify(parsed))
  const {
    '@_Registered': registered,
    '@_OrderID': orderId,
    '@_ChargedAmount': chargedAmount,
    '@_TransactionID': traceId,
  } = result
  const pricePaid = parseFloat(chargedAmount || '0')
  const success = registered === 'true'
  return { success, pricePaid, orderId, responseCode, responseText: error, traceId }
}

module.exports = { checkIsDomainAvailable, purchaseDomain }
