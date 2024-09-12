const gcp = require('../src/gcp-certs')
const le = require('../src/letsencrypt-certs')
const { nameExpires } = require('../src/w3utils')
const SLD_LIST = JSON.parse(process.env.SLD_LIST || '[]')
const getDomainFromDNSNames = ({ dnsNames }) => {
  const t = dnsNames.filter(d => !d.includes('*'))
  if (t.length >= 1) {
    return t[0]
  }
  const parts = dnsNames[0].split('.').filter(p => p !== '*')
  return parts.join('.')
}

async function main () {
  const slds = []
  if (SLD_LIST.length > 0) {
    slds.push(...SLD_LIST.map(e => [e, 0]))
  } else {
    console.log('querying GCP existing certs...')
    const certs = await gcp.listCertificates()
    for (const c of certs) {
      const domain = getDomainFromDNSNames({ dnsNames: c.sanDnsnames })
      const certExpires = Number(c.expireTime.seconds) * 1000
      const sld = domain.split('.')[0]
      slds.push([sld, certExpires])
    }
  }
  console.log('slds:', slds)

  const now = Date.now()
  for (const [sld, certExpires] of slds) {
    const expires = await nameExpires(sld)
    if (expires > now && expires > certExpires + 3600 * 24 * 1000 * 7) {
      // should renew cert
      try {
        const { certId, certMapId } = await le.renewCertificate({ sld })
        console.log(`Renewed ${sld} (expiry: ${new Date(expires).toLocaleString()}) certExpiry=${new Date(certExpires).toLocaleString()} ; certId=${certId} certMapId=${certMapId}`)
      } catch (ex) {
        console.error(ex)
        console.error(`Error renewing SLD ${sld} expiry=${new Date(expires).toLocaleString()})  certExpiry=${new Date(certExpires).toLocaleString()}`)
      }
    } else {
      // skip and log
      console.log(`Skipped renewing for ${sld}; (expiry: ${new Date(expires).toLocaleString()}) certExpiry: ${new Date(certExpires).toLocaleString()}`)
    }
  }
}

main().catch(ex => console.error(ex))
