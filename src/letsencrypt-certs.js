const acme = require('acme-client')
const axios = require('axios')
const fs = require('fs/promises')
const config = require('../config')
const { Storage } = require('@google-cloud/storage')
const { redisClient } = require('./redis')
const { Mutex } = require('async-mutex')
const {
  createSelfManagedCertificate, createCertificateMapEntry, createWcCertificateMapEntry, deleteCertificateMapEntry,
  deleteWcCertificateMapEntry, getCertificate
} = require('./gcp-certs')
const lodash = require('lodash')
const { sleep } = require('./utils')
const { backOff } = require('exponential-backoff')
const { CertJob } = require('./data/certjob')

const storage = new Storage({
  keyFile: config.gcp.certStorage.cred,
})

const bucket = storage.bucket(config.gcp.certStorage.bucket)

const dnsApiBase = axios.create({ baseURL: config.dns.serverApi, timeout: 5000 })

const uploadFile = async (path, content) => {
  return new Promise((resolve, reject) => {
    const blob = bucket.file(path)
    const blobStream = blob.createWriteStream()
    blobStream.on('error', err => {
      reject(err)
    })
    blobStream.on('finish', () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`
      resolve(publicUrl)
    })
    blobStream.end(Buffer.from(content))
  })
}

const removeFile = async (path) => {
  const file = bucket.file(path)
  return file.delete()
}

// eslint-disable-next-line no-unused-vars
const HTTPChallengeFunctions = () => {
  // dummy, not used
  const m = new Mutex()
  return {
    mutex: m,
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      console.log('Creating challenge...')
      if (challenge.type !== 'http-01') {
        throw new Error(`Cannot use challenge function for ${challenge.type}`)
      }
      const path = `.well-known/http-challenge/${challenge.token}`
      console.log(`Creating challenge response for ${authz.identifier.value} at: ${path}`)
      await backOff(async () => {
        await uploadFile(path, keyAuthorization)
      }, {
        numOfAttempts: 5,
        startingDelay: 1000,
        delayFirstAttempt: false,
        retry: async (e, attemptNumber) => {
          console.log(`[HTTPChallengeFunctions][challengeCreateFn][backOff][attempt=${attemptNumber}][domain=${authz?.identifier?.value}] error:`, e)
          return attemptNumber <= 5
        }
      })
      console.log(`Wrote "${keyAuthorization}" at: "${path}"`)
    },
    challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
      console.log('Removing challenge...')
      if (challenge.type !== 'http-01') {
        throw new Error(`Cannot use challenge function for ${challenge.type}`)
      }
      const path = `.well-known/http-challenge/${challenge.token}`
      console.log(`Removing challenge response for ${authz.identifier.value} at path: ${path}`)
      try {
        await removeFile(path)
      } catch (ex) {
        console.error('[HTTPChallengeFunctions][challengeRemoveFn]', ex)
      }
      console.log(`Removed file on path "${path}"`)
    }
  }
}

const DNSChallenger = () => {
  const m = new Mutex()
  return {
    mutex: m,
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      if (authz.identifier.value.split('.').length !== 2) {
        throw new Error(`Not a second level domain: ${authz.identifier.value}`)
      }
      if (challenge.type !== 'dns-01') {
        throw new Error(`Cannot use challenge function for ${challenge.type}`)
      }
      console.log(`Creating DNS challenge for ${authz.identifier.value}`)
      const zone = `${authz.identifier.value}.`
      const key = '_acme-challenge'
      return m.runExclusive(async () => {
        const record = JSON.parse(await redisClient.hGet(zone, key) || '{}')
        const newRecord = { ...record, txt: [...(record?.txt || []), { text: keyAuthorization, ttl: 300 }] }
        const rs = await redisClient.hSet(zone, key, JSON.stringify(newRecord))
        console.log(`[DNS challenge record created] Redis response: ${rs}; old record: ${JSON.stringify(record)}; new record: ${JSON.stringify(newRecord)}`)
      })
    },
    challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
      if (authz.identifier.value.split('.').length !== 2) {
        throw new Error(`Not a second level domain: ${authz.identifier.value}`)
      }
      if (challenge.type !== 'dns-01') {
        throw new Error(`Cannot use challenge function for ${challenge.type}`)
      }
      console.log(`Removing DNS challenge for ${authz.identifier.value}`)
      const zone = `${authz.identifier.value}.`
      const key = '_acme-challenge'
      return m.runExclusive(async () => {
        const record = JSON.parse(await redisClient.hGet(zone, key) || '{}')
        const newTxt = (record?.txt || []).filter(e => e.text !== keyAuthorization)
        const newRecord = newTxt.length > 0 ? { ...record, txt: newTxt } : record
        const rs = Object.keys(newRecord).length > 0
          ? await redisClient.hSet(zone, key, JSON.stringify(newRecord))
          : await redisClient.hDel(zone, key)
        console.log(`[DNS challenge record removed] Redis response: ${rs}; old record: ${JSON.stringify(record)}; new record: ${JSON.stringify(newRecord)}`)
      })
    }
  }
}
async function reloadDnsZone ({ domain }) {
  try {
    const { data: { loaded, success } } = await dnsApiBase.get('/reload', { params: { zone: `${domain}.` } })
    console.log('CoreDNS-Redis server response:', { loaded, success })
  } catch (ex) {
    console.error(`Cannot reload CoreDNS Redis for zone [${domain}.]`, ex?.response?.code, ex?.response?.data)
  }
}

async function setInitialDNS ({ domain }) {
  // set up CAA and other essential records first, before asking letsencrypt to challenge us and issue certificate
  // CAA is critical because letsencrypt will check that first
  const rs = await redisClient.hSet(`${domain}.`, '@', JSON.stringify({
    a: [{ ip: config.dns.ip, ttl: 300 }],
    soa: config.dns.soa,
    caa: [{ ttl: 300, flag: 0, tag: 'issue', value: 'letsencrypt.org' }, { ttl: 300, flag: 0, tag: 'issue', value: 'pki.goog' }]
  }))
  console.log(`[${domain}][setInitialDNS] Redis response A/SOA/CAA: ${rs}`)
  await reloadDnsZone({ domain })
}

async function buildClient ({ staging = false }) {
  let accountKey
  if (config.acmeKeyFile) {
    const key = await fs.readFile(config.acmeKeyFile, { encoding: 'utf-8' })
    accountKey = Buffer.from(key)
  } else {
    accountKey = await acme.crypto.createPrivateKey()
  }
  const client = new acme.Client({ accountKey, directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production })
  return client
}

const logGcpError = (ex, prefix = '[error]') => {
  if (ex.statusDetails) {
    for (let i = 0; i < ex.statusDetails.length; i++) {
      console.error(prefix, i, ex.statusDetails[i])
    }
  }
}

const makeCertCore = async ({ client, csrOptions, useHttp }) => {
  const [key, csr] = await acme.crypto.createCsr(csrOptions)
  // use dns-01 and DNSChallengeFunctions if have wildcards in altNames
  const { mutex, ...funcs } = useHttp ? HTTPChallengeFunctions() : DNSChallenger()
  const challengePriority = useHttp ? ['http-01'] : ['dns-01']
  const certOptions = {
    csr,
    email: 'aaron@hiddenstate.xyz',
    termsOfServiceAgreed: true,
    challengePriority,
    // skipChallengeVerification: true,
    ...funcs
  }
  // console.log(certOptions)
  const cert = await client.auto(certOptions)
  return { cert, key, csr }
}
const makeCert = async ({ client, domain, wcOnly = false, nakedOnly = false }) => {
  let csrOptions = null
  if (wcOnly) {
    csrOptions = { commonName: `*.${domain}` }
  } else if (nakedOnly) {
    csrOptions = { commonName: domain }
  } else if (!nakedOnly && !wcOnly) {
    csrOptions = { commonName: domain, altNames: [domain, `*.${domain}`] }
  } else {
    throw new Error('wcOnly and nakedOnly cannot both be true')
  }
  console.log('[makeCert]', { wcOnly, nakedOnly, domain })
  return makeCertCore({ client, csrOptions, useHttp: nakedOnly })
}

const makeMultiCert = async ({ client, domains, wc = true }) => {
  const commonName = domains[0]
  const altNames = wc ? domains.map(d => [d, `*.${d}`]).flat() : domains
  const csrOptions = { commonName, altNames }
  console.log('[makeMultiCert]', JSON.stringify(domains))
  return makeCertCore({ client, csrOptions, useHttp: !wc })
}

async function createNewCertificate ({ sld, staging = false, wcOnly = false, nakedOnly = false }) {
  if (nakedOnly && wcOnly) {
    throw new Error('wcOnly and nakedOnly cannot both be true')
  }
  const domain = `${sld}.${config.tld}`
  const client = await buildClient({ staging })
  await setInitialDNS({ domain })
  const { cert, key, csr } = await makeCert({ client, domain, wcOnly, nakedOnly })
  try {
    let suffix = ''
    if (wcOnly) {
      suffix = 'wc'
    } else if (nakedOnly) {
      suffix = 'naked'
    }
    const certId = await createSelfManagedCertificate({ domain, cert, key, suffix })
    let certMapId = ''
    if (!wcOnly) {
      ({ certMapId } = await createCertificateMapEntry({ domain, certId }))
    }
    if (!nakedOnly) {
      ({ certMapId } = await createWcCertificateMapEntry({ domain, certId }))
    }
    return { csr, cert, key, certId, certMapId }
  } catch (ex) {
    logGcpError(ex, '[createNewCertificate][error]')
    throw ex
  }
}

async function createNewMultiCertificate ({ id, slds, staging = false, mapEntryWaitPeriod = 0, skipInitDns = false, wc = true }) {
  const existingCert = await getCertificate({ idOverride: id })
  const domains = slds.map(sld => `${sld}.${config.tld}`)
  let csr, cert, key, certId
  if (!existingCert) {
    const client = await buildClient({ staging })
    if (!skipInitDns) {
      for (const [i, chunk] of lodash.chunk(domains, 50).entries()) {
        console.log(`[createNewMultiCertificate] processing batch ${i} of ${chunk.length}/${slds.length} domains`)
        await Promise.all(chunk.map(d => setInitialDNS({ domain: d })))
      }
    }
    ({ cert, key, csr } = await makeMultiCert({ client, domains, wc }))
    certId = await createSelfManagedCertificate({ idOverride: id, cert, key })
  } else {
    certId = existingCert.name
  }

  const results = []
  for (const [i, chunk] of lodash.chunk(domains, 10).entries()) {
    try {
      const certMapIds = await Promise.all(chunk.map(domain => createCertificateMapEntry({ domain, certId })))
      let wcCertMapIds
      if (wc) {
        wcCertMapIds = await Promise.all(chunk.map(domain => createWcCertificateMapEntry({ domain, certId })))
      }
      for (let j = 0; j < chunk.length; j++) {
        results.push({ domain: chunk[i], certMapId: certMapIds[i].certMapId, wcCertMapId: wcCertMapIds ? wcCertMapIds[i].certMapId : undefined })
        // results.push({ domain: chunk[i], certMapId: certMapIds[i].certMapId })
      }
    } catch (ex) {
      logGcpError(ex, '[createNewMultiCertificate]')
    } finally {
      if (mapEntryWaitPeriod) {
        await sleep(mapEntryWaitPeriod)
      }
    }
  }
  return { csr, cert, key, results }
}

const makeTimeBasedSuffix = () => new Date().toISOString().slice(0, 19).replaceAll(':', '-').toLowerCase()

async function renewCertificate ({ sld, staging = false, wcOnly = false, nakedOnly = false }) {
  if (nakedOnly && wcOnly) {
    throw new Error('wcOnly and nakedOnly cannot both be true')
  }
  const domain = `${sld}.${config.tld}`
  const client = await buildClient({ sld, staging })
  const { cert, key, csr } = await makeCert({ client, domain, wcOnly, nakedOnly })
  try {
    const certId = await createSelfManagedCertificate({ domain, cert, key, suffix: makeTimeBasedSuffix() })
    if (!wcOnly) {
      await deleteCertificateMapEntry({ sld })
    }
    if (!nakedOnly) {
      await deleteWcCertificateMapEntry({ sld })
    }
    let certMapId
    if (!wcOnly) {
      ({ certMapId } = await createCertificateMapEntry({ domain, certId }))
    }
    if (!nakedOnly) {
      ({ certMapId } = await createWcCertificateMapEntry({ domain, certId }))
    }
    return { csr, cert, key, certId, certMapId }
  } catch (ex) {
    logGcpError(ex, '[renewCertificate][error]')
    throw ex
  }
}

module.exports = { createNewCertificate, createNewMultiCertificate, renewCertificate, setInitialDNS }
