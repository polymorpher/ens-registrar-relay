const { GenericBuilder } = require('./generic')
const CertJobPrototype = GenericBuilder('certjob')
const CertJob = ({
  ...CertJobPrototype,
  addNew: async ({ jobId, domain, certId, certMapId, wc, renew }) => {
    const details = {
      jobId,
      certId,
      certMapId,
      domain,
      wc,
      renew,
      completed: false,
      success: false,
      attempts: 0,
      error: ''
    }
    return CertJobPrototype.add(jobId, details)
  },
  findCompletedJobs: async ({ domain, wc }) => {
    if (typeof wc === 'undefined' || wc === null) {
      return CertJobPrototype.find(['domain', domain], ['completed', true])
    }
    return CertJobPrototype.find(['domain', domain], ['completed', true], ['wc', wc])
  },
  findPendingJobs: async ({ domain, wc }) => {
    if (typeof wc === 'undefined' || wc === null) {
      return CertJobPrototype.find(['domain', domain], ['completed', false])
    }
    return CertJobPrototype.find(['domain', domain], ['completed', false], ['wc', wc])
  },
})

module.exports = { CertJob }
