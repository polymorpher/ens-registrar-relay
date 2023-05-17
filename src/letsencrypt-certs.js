const acme = require('acme-client')
const axios = require('axios')
const fs = require('fs/promises')
const config = require('../config')
const { Storage } = require('@google-cloud/storage')
const { redisClient } = require('./redis')
const { Mutex } = require('async-mutex')
const {
  createSelfManagedCertificate, createCertificateMapEntry, createWcCertificateMapEntry, deleteCertificateMapEntry,
  deleteWcCertificateMapEntry
} = require('./gcp-certs')

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
      await uploadFile(path, keyAuthorization)
      console.log(`Wrote "${keyAuthorization}" at: "${path}"`)
    },
    challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
      console.log('Removing challenge...')
      if (challenge.type !== 'http-01') {
        throw new Error(`Cannot use challenge function for ${challenge.type}`)
      }
      const path = `.well-known/http-challenge/${challenge.token}`
      console.log(`Removing challenge response for ${authz.identifier.value} at path: ${path}`)
      await removeFile(path)
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
  console.log(`Redis response A/SOA/CAA: ${rs}`)
  await reloadDnsZone({ domain })
}

async function buildClient ({ sld, staging = false }) {
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
  const [key, csr] = await acme.crypto.createCsr(csrOptions)
  // use dns-01 and DNSChallengeFunctions if have wildcards in altNames
  console.log('[makeCert]', { wcOnly, nakedOnly, domain })
  const { mutex, ...funcs } = nakedOnly ? HTTPChallengeFunctions() : DNSChallenger()
  const certOptions = {
    csr,
    email: 'aaron@hiddenstate.xyz',
    termsOfServiceAgreed: true,
    challengePriority: nakedOnly ? ['http-01'] : ['dns-01'],
    // skipChallengeVerification: true,
    ...funcs
  }
  // console.log(certOptions)
  const cert = await client.auto(certOptions)
  return { cert, key, csr }
}
async function createNewCertificate ({ sld, staging = false, wcOnly = false, nakedOnly = false }) {
  if (nakedOnly && wcOnly) {
    throw new Error('wcOnly and nakedOnly cannot both be true')
  }
  const domain = `${sld}.${config.tld}`
  const client = await buildClient({ sld, staging })
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

module.exports = { createNewCertificate, renewCertificate }
