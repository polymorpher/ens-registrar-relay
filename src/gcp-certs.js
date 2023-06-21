const { CertificateManagerClient } = require('@google-cloud/certificate-manager').v1
const config = require('../config')
const { redisClient } = require('./redis')
const lodash = require('lodash')
const client = new CertificateManagerClient()
const parent = `projects/${config.gcp.gceProjectId}/locations/global`

/*
  References:
  There is no good GCP documentation for the end-to-end flow in node.js (or other languages). The sample code provided there is generated by templates, and offers little guidance. They won't get your anywhere.

  To understand the flow, data structures, and parameters, you need to review the following documents and put the pices together
  Certificate Manager Client: https://cloud.google.com/nodejs/docs/reference/certificate-manager/latest/certificate-manager/v1.certificatemanagerclient
  Various data structures: https://cloud.google.com/nodejs/docs/reference/certificate-manager/latest/overview (you can import the actual types and protobuf constructors using path protos.google.api.... under require('@google-cloud/certificate-manager'), but there is no need to do so as long as you match the names of each field in the arguments, when you call functions from Certificate Manager Client

  For some data structures and function calls, the REST API document gives a clearer view of what's needed, e.g.
  https://cloud.google.com/certificate-manager/docs/reference/rest/v1/projects.locations.certificateMaps.certificateMapEntries

  For end-to-end flow example via CLI, see
  https://cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth

  The code below assumes you already set up a load balancer with correct target-proxies, manually created a certificate map, and manually created self-managed certificates for the master domain (names.country and *.names.country). If you want to replicate the whole process in a fresh project, you need to set them up by yourself in commandline. Use GCP console UI to set up the load balancer, then review the following documents for setting up target https proxies and creating self-managed certificates (and adding it to

  https://cloud.google.com/certificate-manager/docs/reference/rest/v1/projects.locations.certificates#SelfManagedCertificate
  https://cloud.google.com/certificate-manager/docs/reference/rest/v1/projects.locations.certificates/create
  https://cloud.google.com/certificate-manager/docs/reference/rest/v1/projects.locations.certificateMaps
  https://cloud.google.com/certificate-manager/docs/reference/rest/v1/projects.locations.certificateMaps/create
  https://cloud.google.com/sdk/gcloud/reference/compute/target-https-proxies

  In naming resources, we also must follow naming convention:
  https://cloud.google.com/compute/docs/naming-resources
 */

const createCertificateMapEntry = async ({ domain, certId }) => {
  const domainId = domain.replaceAll('.', '-')
  const certificateMapEntryId = domainId
  certId = certId || `${parent}/certificates/${domainId}`
  const certMapId = `${parent}/certificateMaps/${config.gcp.certificateMapId}`
  const [opCertMapEntryCreate] = await client.createCertificateMapEntry({
    parent: certMapId,
    certificateMapEntryId,
    certificateMapEntry: {
      hostname: domain,
      certificates: [certId]
    }
  })
  await opCertMapEntryCreate.promise()
  console.log(`[createCertificateMapEntry] created for entryId=${certificateMapEntryId} under map=${certMapId}, certId=${certId}`)
  return {
    certId,
    certMapId,
  }
}

const createWcCertificateMapEntry = async ({ domain, certId }) => {
  const domainId = domain.replaceAll('.', '-')
  certId = certId || `${parent}/certificates/${domainId}`
  const certMapId = `${parent}/certificateMaps/${config.gcp.certificateMapId}`
  const [opWcCertMapEntryCreate] = await client.createCertificateMapEntry({
    parent: certMapId,
    certificateMapEntryId: `wc-${domainId}`,
    certificateMapEntry: {
      hostname: `*.${domain}`,
      certificates: [certId]
    }
  })
  await opWcCertMapEntryCreate.promise()
  console.log(`[createWcCertificateMapEntry] created for entryId=wc-${domainId} under map=${certMapId}, certId=${certId}`)
  return {
    certId,
    certMapId,
  }
}

const createNewCertificate = async ({ sld }) => {
  if (!redisClient || !redisClient.isReady) {
    console.error(`Redis client is unavailable. Skipped certificate creation for ${sld}`)
    return
  }
  const domain = `${sld}.${config.tld}`
  const domainId = domain.replaceAll('.', '-')
  const [opDnsAuth] = await client.createDnsAuthorization({ parent, dnsAuthorization: { domain }, dnsAuthorizationId: domainId })
  await opDnsAuth.promise()
  const dnsAuthId = `${parent}/dnsAuthorizations/${domainId}`
  const [{ dnsResourceRecord: { name, type, data } }] = await client.getDnsAuthorization({ name: dnsAuthId })
  console.log('DNS Auth', { sld, name, type, data })
  const rs1 = await redisClient.hSet(`${domain}.`, name.replace(`.${domain}.`, ''), JSON.stringify({
    cname: [{ host: data, ttl: 300 }]
  }))
  console.log(`Redis response CNAME: ${rs1}`)
  const rs2 = await redisClient.hSet(`${domain}.`, '@', JSON.stringify({
    a: [{ ip: config.dns.ip, ttl: 300 }],
    soa: config.dns.soa,
    caa: [{ ttl: 300, flag: 0, tag: 'issue', value: 'letsencrypt.org' }, { ttl: 300, flag: 0, tag: 'issue', value: 'pki.goog' }]
  }))
  console.log(`Redis response A/SOA/CAA: ${rs2}`)
  const [opCertCreate] = await client.createCertificate({
    parent,
    certificateId: domainId,
    certificate: {
      managed: {
        domains: [domain, `*.${domain}`],
        dnsAuthorizations: [dnsAuthId]
      }
    }
  })
  await opCertCreate.promise()
  console.log('Managed-Certificate created')
  const { certId, certMapId } = await createCertificateMapEntry({ domain })
  await createWcCertificateMapEntry({ domain })
  return {
    domain,
    domainId,
    certId,
    certMapId,
    dnsAuthId,
  }
}

const getSelfManagedCertificateId = ({ idOverride = undefined, domain, suffix }) => {
  const domainId = domain?.replaceAll('.', '-')
  const id = idOverride ?? `${domainId}${suffix ? ('-' + suffix) : ''}`
  const certId = `${parent}/certificates/${id}`
  return [certId, id]
}
const createSelfManagedCertificate = async ({ idOverride = undefined, domain, cert, key, suffix }) => {
  const [certId, partialId] = getSelfManagedCertificateId({ idOverride, domain, suffix })
  const [opCertCreate] = await client.createCertificate({
    parent,
    certificateId: partialId,
    certificate: {
      selfManaged: {
        pemCertificate: cert.toString().replaceAll('\n\n', '\n'),
        pemPrivateKey: key.toString(),
      }
    }
  })
  await opCertCreate.promise()
  console.log(`GCP: Self-managed certificate created for ${domain}; certId=${certId}`)
  return certId
}

const deleteCertificateMapEntry = async ({ sld }) => {
  const domain = `${sld}.${config.tld}`
  const domainId = domain.replaceAll('.', '-')
  const certMapId = `${parent}/certificateMaps/${config.gcp.certificateMapId}`
  const mapEntryId = `${certMapId}/certificateMapEntries/${domainId}`
  const [op1] = await client.deleteCertificateMapEntry({ name: mapEntryId })
  const r1 = await op1.promise()
  console.log(`Deleted ${mapEntryId}`, r1)
}

const deleteWcCertificateMapEntry = async ({ sld }) => {
  const domain = `${sld}.${config.tld}`
  const domainId = domain.replaceAll('.', '-')
  const certMapId = `${parent}/certificateMaps/${config.gcp.certificateMapId}`
  const mapEntryWcId = `${certMapId}/certificateMapEntries/wc-${domainId}`
  const [op2] = await client.deleteCertificateMapEntry({ name: mapEntryWcId })
  const r2 = await op2.promise()
  console.log(`Deleted ${mapEntryWcId}`, r2)
}
const deleteCertificate = async ({ sld, suffix }) => {
  const domain = `${sld}.${config.tld}`
  const [certId] = getSelfManagedCertificateId({ domain, suffix })
  const [op3] = await client.deleteCertificate({ name: certId })
  const r3 = await op3.promise()
  console.log(`Deleted ${certId}`, r3)
}

const deleteDnsAuth = async ({ sld }) => {
  const domain = `${sld}.${config.tld}`
  const domainId = domain.replaceAll('.', '-')
  const dnsAuthId = `${parent}/dnsAuthorizations/${domainId}`
  const [op4] = await client.deleteDnsAuthorization({ name: dnsAuthId })
  const r4 = await op4.promise()
  console.log(`Deleted ${dnsAuthId}`, r4)
}

const cleanup = async ({ sld }) => {
  await deleteCertificateMapEntry({ sld })
  await deleteWcCertificateMapEntry({ sld })
  await deleteCertificate({ sld })
  await deleteDnsAuth({ sld })
}

const getCertificate = async ({ idOverride = undefined, sld, suffix }) => {
  const domain = `${sld}.${config.tld}`
  const [certId] = getSelfManagedCertificateId({ idOverride, domain, suffix })
  try {
    const [cr] = await client.getCertificate({ name: certId })
    return cr
  } catch (ex) {
    console.error('[getCertificate]', sld, ex?.code, ex?.details)
    return null
  }
}

// TODO: pagination
const listCertificates = async () => {
  const [certs] = await client.listCertificates({ parent })
  return certs
}

const getCertificateMapEntry = async ({ sld, wc = false }) => {
  const domain = `${sld}.${config.tld}`
  const domainId = domain.replaceAll('.', '-')
  const certMapId = `${parent}/certificateMaps/${config.gcp.certificateMapId}`
  const mapEntryId = wc ? `${certMapId}/certificateMapEntries/wc-${domainId}` : `${certMapId}/certificateMapEntries/${domainId}`
  try {
    const [mapEntry] = await client.getCertificateMapEntry({ name: mapEntryId })
    return mapEntry
  } catch (ex) {
    console.error(`[getCertificateMapEntry][wc=${wc}]`, sld, ex?.code, ex?.details)
    return null
  }
}

const filterSldsWithoutCert = async ({ slds }) => {
  const results = []
  for (const [i, chunk] of lodash.chunk(slds, 10).entries()) {
    console.log(`[filterSldsWithoutCert] Looking up chunk ${i} of ${chunk.length}/${slds.length} domains`)
    const mapEntries = await Promise.all(chunk.map(sld => getCertificateMapEntry({ sld })))
    const mapEntries2 = await Promise.all(chunk.map(sld => getCertificateMapEntry({ sld, wc: true })))
    const domainsWihoutCerts = mapEntries.map((m, i) => m && mapEntries2[i] ? null : chunk[i])
    results.push(...domainsWihoutCerts.filter(e => e))
  }
  return results
}

const parseCertId = (certId) => {
  const parts = certId.split('/')
  const id = parts[parts.length - 1]
  const [sld, , ...suffix] = id.split('-')
  return [sld, suffix.join('-')]
}

module.exports = {
  createNewCertificate,
  createCertificateMapEntry,
  createWcCertificateMapEntry,
  createSelfManagedCertificate,
  deleteCertificate,
  getCertificate,
  deleteCertificateMapEntry,
  deleteWcCertificateMapEntry,
  getSelfManagedCertificateId,
  cleanup,
  listCertificates,
  getCertificateMapEntry,
  parseCertId,
  filterSldsWithoutCert
}
