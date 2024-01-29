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
  config.params.ClientIp = config.params.ClientIp || appConfig.namecheap.defaultIp
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
      ProductName: appConfig.tld
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  const options = parsed?.CommandResponse?.UserGetPricingResult?.ProductType?.ProductCategory?.Product?.Price || []
  const {
    '@_Price': basePrice,
    '@_AdditionalCost': additionalCost,
    '@_RegularPrice': regularPrice,
  } = options?.[0] || {}
  const price = (parseFloat(basePrice) + parseFloat(additionalCost)) || 0.0
  console.log(`[namecheap][price][${priceType}]`, { price, basePrice, additionalCost, regularPrice })
  const ret = {
    price,
    basePrice: parseFloat(basePrice || '0.0'),
    additionalCost: parseFloat(additionalCost || '0.0'),
    regularPrice: parseFloat(regularPrice || '0.0')
  }
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
  const result = parsed?.CommandResponse?.DomainCheckResult || {}
  const {
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
  } = result
  const responseText = responseDesc || error
  const isRegistered = !(responseAvailable?.toLowerCase() === 'true')
  const isReserved = isPremium?.toLowerCase() === 'true'
  const isAvailable = !error && !isRegistered && !isReserved
  const { price: regPrice } = await checkTldPrice({ ip })
  const { price: renewPrice } = await checkTldPrice({ ip, priceType: 'RENEW' })
  const { price: transferPrice } = await checkTldPrice({ ip, priceType: 'TRANSFER' })
  console.log('[namecheap][check]', sld, { isAvailable, isReserved, isRegistered, regPrice })
  return { isAvailable, isReserved, isRegistered, regPrice, renewPrice, transferPrice, responseText, responseCode }
}

const purchaseDomain = async ({ sld, ip = appConfig.namecheap.defaultIp }) => {
  const r = appConfig.namecheap.defaultRegistrant
  const admin = appConfig.namecheap.defaultContact('Admin')
  const tech = appConfig.namecheap.defaultContact('Tech')
  const aux = appConfig.namecheap.defaultContact('AuxBilling')
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.domains.create',
      DomainName: `${sld}.${appConfig.tld}`,
      Years: '1',
      AddFreeWhoisguard: 'yes',
      WGEnabled: 'yes',
      Nameservers: `${appConfig.namecheap.ns1},${appConfig.namecheap.ns2}`,
      ClientIp: ip,
      ...r,
      ...admin,
      ...tech,
      ...aux,
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  const error = parsed?.Errors?.Error?.['#text']
  const responseCode = parseInt(parsed?.Errors?.Error?.['@_Number'] || '0')
  const result = parsed?.CommandResponse?.DomainCreateResult
  const {
    '@_Registered': registered,
    '@_OrderID': orderId,
    '@_ChargedAmount': chargedAmount,
    '@_TransactionID': traceId,
  } = result || {}
  const pricePaid = parseFloat(chargedAmount || '0')
  const success = registered === 'true'
  console.log('[namecheap][purchase]', sld, { success, pricePaid, orderId })
  return { success, pricePaid, orderId, responseCode, responseText: error, traceId }
}

async function listOwnedDomains ({ pageSize = 100, page = 0, expiring = false }) {
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.domains.getList',
      ListType: expiring ? 'EXPIRING' : 'ALL',
      PageSize: pageSize,
      Page: page + 1,
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  const result = parsed?.CommandResponse?.DomainGetListResult?.Domain || []
  // console.log(result)
  const error = parsed?.Errors?.Error?.['#text']
  const responseCode = parseInt(parsed?.Errors?.Error?.['@_Number'] || '0')
  const { TotalItems: totalItems, CurrentPage: currentPage, PageSize: actualPageSize } = parsed?.CommandResponse?.Paging ?? {}
  // console.log(result)
  const domains = result.map((entry) => {
    const { '@_Name': name, '@_Created': created, '@_Expires': expires, '@_IsExpired': isExpired, '@_IsLocked': isLocked, '@_AutoRenew': autoRenew, '@_IsPremium': isPremium } = entry
    return {
      name,
      created: new Date(created).getTime(),
      expires: new Date(expires).getTime(),
      isExpired: isExpired === 'true',
      isLocked: isLocked === 'true',
      autoRenew: autoRenew === 'true',
      isPremium: isPremium === 'true'
    }
  })
  return {
    error,
    responseCode,
    domains,
    totalItems,
    currentPage,
    actualPageSize
  }
}

async function renewDomain ({ sld, ip = appConfig.namecheap.defaultIp }) {
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.domains.renew',
      DomainName: `${sld}.${appConfig.tld}`,
      IsPremiumDomain: 'false',
      Years: '1',
      ClientIp: ip
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  const error = parsed?.Errors?.Error?.['#text']
  const responseCode = parseInt(parsed?.Errors?.Error?.['@_Number'] || '0')
  const result = parsed?.CommandResponse?.DomainCreateResult
  const {
    '@_Renew': renewed,
    '@_OrderID': orderId,
    '@_ChargedAmount': chargedAmount,
    '@_TransactionID': traceId,
  } = result || {}
  const pricePaid = parseFloat(chargedAmount || '0')
  const success = renewed === 'true'
  console.log('[namecheap][renew]', sld, { success, pricePaid, orderId })
  return { success, pricePaid, orderId, responseCode, responseText: error, traceId }
}

async function domainInfo ({ sld, ip = appConfig.namecheap.defaultIp }) {
  const { data } = await base.get('/xml.response', {
    params: {
      Command: 'namecheap.domains.getinfo',
      DomainName: `${sld}.${appConfig.tld}`,
      ClientIp: ip
    }
  })
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const parsed = parser.parse(data).ApiResponse
  const error = parsed?.Errors?.Error?.['#text']
  const responseCode = parseInt(parsed?.Errors?.Error?.['@_Number'] || '0')
  const isOwner = parsed?.CommandResponse?.DomainGetInfoResult?.['@_IsOwner'] === 'true'
  const { CreatedDate, ExpiredDate } = parsed?.CommandResponse?.DomainGetInfoResult?.DomainDetails ?? {}
  return { isOwner, createTime: new Date(CreatedDate).getTime(), expiryTime: new Date(ExpiredDate).getTime(), error, responseCode }
}

module.exports = { checkIsDomainAvailable, purchaseDomain, listOwnedDomains, renewDomain, domainInfo }
