const { GenericBuilder } = require('./generic')
const PurchasePrototype = GenericBuilder('purchase')
const purchaseDetails = ({
  address, pricePaid, orderId, domainCreationDate, domainExpiryDate, responseCode, responseText, traceId, reqTime,
  certId, certMapId, dnsAuthId
}) => ({
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
})

const Purchase = ({
  ...PurchasePrototype,
  addNew: async ({ domain, ...rest }) => PurchasePrototype.add(domain, purchaseDetails(rest)),
  upsertNew: async ({ domain, ...rest }) => PurchasePrototype.upsert(domain, purchaseDetails(rest))
})

module.exports = { Purchase }
