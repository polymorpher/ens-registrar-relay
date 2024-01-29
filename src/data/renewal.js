const { GenericBuilder } = require('./generic')
const RenewalPrototype = GenericBuilder('renewal')
const Renewal = ({
  ...RenewalPrototype,
  addNew: async ({
    domain, pricePaid, orderId, domainCreationTime, domainExpiryTime, duration, responseCode, responseText, traceId
  }) => {
    const details = {
      pricePaid,
      orderId,
      domainCreationTime,
      domainExpiryTime,
      duration,
      responseCode,
      responseText,
      traceId,
    }
    return Renewal.add(domain, details)
  }
})

module.exports = { Renewal }
