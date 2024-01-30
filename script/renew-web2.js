const DomainList = process.env.DOMAIN_LIST ? JSON.parse(process.env.DOMAIN_LIST) : []
const { listOwnedDomains, renewDomain } = require('../src/namecheap-api')
const LookupOnly = !!process.env.LOOKUP_ONLY
async function queryExpiredDomains () {
  let page = 0; let totalPages = 0; const pageSize = 100
  const allDomains = []
  while (totalPages === 0 || page < totalPages) {
    const { domains, totalItems } = await listOwnedDomains({ page, expiring: true })
    if (totalPages === 0) {
      totalPages = Math.ceil(totalItems / pageSize)
    }
    console.log(`Page ${page}, got ${domains.length} results`)
    console.log(JSON.stringify(domains.map(e => e.name)))
    page += 1
    allDomains.push(...domains)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return allDomains
}

async function main () {
  let domains = [...DomainList]
  if (domains.length === 0) {
    domains = await queryExpiredDomains()
  }
  console.log(domains)
  const premiumDomains = []
  const skippedDomains = []
  const renewedDomains = []
  const renewalErrorDomains = []
  for (const { name: domain, isPremium } of domains) {
    if (isPremium) {
      premiumDomains.push(domain)
      console.log(`Skipping premium domain: ${domain}`)
      continue
    }
    const sld = domain.split('.')[0]
    if (domain.startsWith('testtest') || domain.startsWith('francisco') || sld.length > 15) {
      skippedDomains.push(domain)
      console.log(`Skipping ${domain}`)
      continue
    }

    if (!LookupOnly) {
      const { success, pricePaid, orderId, responseCode, error } = await renewDomain({ sld })
      if (!success) {
        console.error(`Error renewing ${sld} (${domain}) code=${responseCode} error=${error}`)
        renewalErrorDomains.push(domain)
        continue
      }
      console.log(`Renewed ${domain} success=${success} pricePaid=${pricePaid} orderId=${orderId}`)
      await new Promise((resolve) => setTimeout(resolve, 5500))
    }
    renewedDomains.push(domain)
  }
  console.log('Premium domains not renewed:', premiumDomains)
  console.log('Renewed domains:', renewedDomains)
  console.log('Skipped regular domains:', skippedDomains)
  console.log('Renewal error domains:', renewalErrorDomains)
}

main().catch(console.error)
