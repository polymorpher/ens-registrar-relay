const { GenericBuilder } = require('./generic')
const PurchasePrototype = GenericBuilder('purchase')
const Purchase = ({
  ...PurchasePrototype,
  addNew: async ({
    domain, address, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime,
    certId, certMapId, dnsAuthId
  }) => {
    const details = {
      address,
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
    }
    return PurchasePrototype.add(domain, details)
  }
})

module.exports = { Purchase }
