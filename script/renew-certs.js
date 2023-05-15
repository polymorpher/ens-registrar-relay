const gcp = require('../src/gcp-certs')
const le = require('../src/letsencrypt-certs')
async function main () {
  const certs = gcp.listCertificates()
}

main().catch(ex => console.error(ex))
