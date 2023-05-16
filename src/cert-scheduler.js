const { v1: uuid } = require('uuid')
const le = require('./letsencrypt-certs')
const { backOff } = require('exponential-backoff')
const config = require('../config')
const { CertJob } = require('./data/certjob')

async function lookup ({ sld, wc }) {
  const domain = `${sld}.${config.tld}`
  const jobs = await CertJob.findPendingJobs({ domain, wc })
  return jobs.map(j => {
    const { completed, success, attempts, jobId, wc, creationTime, timeUpdated } = j
    return { completed, success, attempts, jobId, wc, creationTime, timeUpdated }
  })
}

async function lookupByJobId ({ jobId }) {
  const job = await CertJob.get(jobId)
  if (!job) {
    return null
  }
  const { completed, success, attempts, wc, creationTime, timeUpdated } = job
  return { completed, success, attempts, jobId, wc, creationTime, timeUpdated }
}

async function schedule ({ sld, wc, renew = false }) {
  if (wc !== true && wc !== false) {
    throw new Error('wc must be true or false')
  }
  const domain = `${sld}.${config.tld}`
  const jobs = await lookup({ sld, wc })
  if (jobs.length >= 1) {
    return { error: 'already scheduled', jobId: jobs[0].jobId, creationTime: jobs[0].creationTime }
  }
  const jobId = uuid()
  await CertJob.addNew({ jobId, domain, wc })
  backOff(async () => {
    const options = wc ? { wcOnly: true } : { nakedOnly: true }
    let certId = ''; let certMapId = ''
    if (renew) {
      ({ certId, certMapId } = await le.renewCertificate({ sld, ...options }))
    } else {
      ({ certId, certMapId } = await le.createNewCertificate({ sld, ...options }))
    }
    await CertJob.update(jobId, { completed: true, success: true, certId, certMapId })
  }, {
    numOfAttempts: 5,
    startingDelay: 10000,
    delayFirstAttempt: false,
    retry: async (e, attemptNumber) => {
      console.log(`[backOff][attempt=${attemptNumber}][domain=${domain}] error:`, e)
      if (attemptNumber > 5) {
        await CertJob.update(jobId, { error: e.toString(), completed: true })
        return false
      } else {
        await CertJob.update(jobId, { error: e.toString(), attempts: attemptNumber })
        return true
      }
    }
  })
  return { success: true, jobId }
}

module.exports = { lookup, schedule, lookupByJobId }
