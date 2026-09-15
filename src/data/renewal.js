const { GenericBuilder } = require('./generic')
const RenewalPrototype = GenericBuilder('renewal')
const renewalDetails = ({
  pricePaid, orderId, domainCreationTime, domainExpiryTime, duration, responseCode, responseText, traceId
}) => ({
  pricePaid,
  orderId,
  domainCreationTime,
  domainExpiryTime,
  duration,
  responseCode,
  responseText,
  traceId,
})

const Renewal = ({
  ...RenewalPrototype,
  addNew: async ({ domain, ...rest }) => RenewalPrototype.add(domain, renewalDetails(rest)),
  upsertNew: async ({ domain, ...rest }) => RenewalPrototype.upsert(domain, renewalDetails(rest))
})

module.exports = { Renewal }
