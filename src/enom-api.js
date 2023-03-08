const axios = require('axios')
const appConfig = require('../config')
const { XMLParser } = require('fast-xml-parser')

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
  console.log('[enom][check-domain]', sld, { isAvailable, isReserved, isRegistered, regPrice })
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
  console.log('[enom][purchase-domain]', sld, { success, pricePaid })
  return { success, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime }
}

module.exports = { checkIsDomainAvailable, purchaseDomain }
