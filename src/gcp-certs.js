const Redis = require('redis')
const { CertificateManagerClient } = require('@google-cloud/certificate-manager').v1
const config = require('../config')
const client = new CertificateManagerClient()

const parent = `projects/${config.gcp.gceProjectId}/locations/global`

let redisClient

const init = async () => {
  if (redisClient) {
    return
  }
  redisClient = Redis.createClient({ url: config.redis.url })
  await redisClient.connect()
  return redisClient.isReady
}

const test = async () => {
  const testRes = await redisClient.keys('*')
  console.log(testRes)
}

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
    cname: [{ host: data, ttl: 3600 }]
  }))
  console.log(`Redis response CNAME: ${rs1}`)
  const rs2 = await redisClient.hSet(`${domain}.`, '@', JSON.stringify({
    a: [{ ip: config.dns.ip, ttl: 3600 }]
  }))
  console.log(`Redis response A: ${rs2}`)
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
  console.log('Certificate created')
  const certId = `${parent}/certificates/${domainId}`
  const certMapId = `${parent}/certificateMaps/${config.gcp.certificateMapId}`
  const [opCertMapEntryCreate] = await client.createCertificateMapEntry({
    parent: certMapId,
    certificateMapEntryId: domainId,
    certificateMapEntry: {
      hostname: domain,
      certificates: [certId]
    }
  })
  await opCertMapEntryCreate.promise()
  console.log(`CertificateMapEntry created for ${domainId} under ${parent}`)
  const [opWcCertMapEntryCreate] = await client.createCertificateMapEntry({
    parent: certMapId,
    certificateMapEntryId: `wc-${domainId}`,
    certificateMapEntry: {
      hostname: `*.${domain}`,
      certificates: [certId]
    }
  })
  await opWcCertMapEntryCreate.promise()
  console.log(`CertificateMapEntry created for wc-${domainId} under ${parent}`)
  return {
    domain,
    domainId,
    certId,
    certMapId,
    dnsAuthId,
  }
}

module.exports = { createNewCertificate, init, redisClient }
