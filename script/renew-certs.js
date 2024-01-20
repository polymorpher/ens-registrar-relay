const gcp = require('../src/gcp-certs')
const le = require('../src/letsencrypt-certs')
const { nameExpires } = require('../src/w3utils')
const getDomainFromDNSNames = ({ dnsNames }) => {
  const t = dnsNames.filter(d => !d.includes('*'))
  if (t.length >= 1) {
    return t[0]
  }
  const parts = dnsNames[0].split('.').filter(p => p !== '*')
  return parts.join('.')
}

async function main () {
  const certs = await gcp.listCertificates()
  const now = Date.now()
  for (const c of certs) {
    const domain = getDomainFromDNSNames({ dnsNames: c.sanDnsnames })
    const certExpires = Number(c.expireTime.seconds) * 1000
    const sld = domain.split('.')[0]
    const expires = await nameExpires(sld)
    if (expires > now && expires > certExpires + 3600 * 24 * 1000 * 7) {
      // should renew cert
      try {
        const { certId, certMapId } = await le.renewCertificate({ sld })
        console.log(`Renewed ${sld} (expiry: ${new Date(expires).toLocaleString()}) certExpiry=${new Date(certExpires).toLocaleString()} ; certId=${certId} certMapId=${certMapId}`)
      } catch (ex) {
        console.error(ex)
        console.error(`Error renewing domain ${domain} expiry=${new Date(expires).toLocaleString()})  certExpiry=${new Date(certExpires).toLocaleString()}`)
      }
    } else {
      // skip and log
      console.log(`Skipped renewing for ${sld}; (expiry: ${new Date(expires).toLocaleString()}) certExpiry: ${new Date(certExpires).toLocaleString()}`)
    }
  }
}

main().catch(ex => console.error(ex))
