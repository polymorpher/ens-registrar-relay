const gcp = require('../src/gcp-certs')
const le = require('../src/letsencrypt-certs')
const lodash = require('lodash')
const { sleep } = require('../src/utils')
const dig = require('node-dig-dns')
const config = require('../config')
const chars = []

const CertIdPrefix = process.env.CERT_ID_PREFIX ?? `batch-cert-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
const ValidARecords = JSON.parse(process.env.VALID_A_RECORDS ?? '["34.160.72.19","34.160.89.33"]')
const Excluded = process.env.EXCLUDED_DOMAINS
  ? JSON.parse(process.env.EXCLUDED_DOMAINS)
  : ['li', 'ml', 'ba', 'ec', 'au', 'ep', 'eu', 'un',
      '0', '00', '01', '02', '03', '04',
      'h', '0', '1', 's',
      'j', 'g', 'm', 'r',
      'i', 'q', '9',
      'af', 'ak', 'al', 'am', 'jn', 'rh', 'sa', 'tp', 'tf', 'ym'
    ]
const ForceIncludeList = JSON.parse(process.env.FORCE_INCLUDE_LIST ?? '[]')

const GenerateWildcard = process.env.GENERATE_WILDCARD === '1' || process.env.GENERATE_WILDCARD === 'true'

const AssignedSlds = JSON.parse(process.env.SLDS ?? '[]')

async function batchGenerate ({ slds, id }) {
  console.log(`generating certs for ${slds.length} slds: ${JSON.stringify(slds)}`)
  // const finalSlds = []
  // for (const chunk of lodash.chunk(slds, 150)) {
  //   const filtered = await gcp.filterSldsWithoutCert({ slds: chunk, checkWc: false })
  //   console.log(`added ${filtered.length} slds: ${JSON.stringify(filtered)}`)
  //   // await Promise.all(chunk.map(domain => le.setInitialDNS({ domain })))
  //   finalSlds.push(...filtered)
  //   console.log('Sleeping for 60 seconds')
  //   await sleep(60)
  // }
  const badDomains = []
  const filteredSlds = await gcp.filterSldsWithoutCert({ slds, checkWc: false, checkExpiry: true })
  console.log(`filteredSlds: ${filteredSlds.length}`)
  const finalSlds = []
  for (const chunk of lodash.chunk(filteredSlds, 50)) {
    const answers = await Promise.all(chunk.map(sld => dig([`${sld}.${config.tld}`, 'A'])))
    const filteredChunk = answers.filter(e => ForceIncludeList.includes(e.answer[0].domain.split('.')[0]) || ValidARecords.includes(e?.answer?.[0]?.value))
      .map(e => e.answer[0].domain.split('.')[0])
    const badChunk = lodash.difference(chunk, filteredChunk)
    badDomains.push(...badChunk)
    console.log('badChunk:', badChunk)
    console.log(`added ${filteredChunk.length} slds: ${JSON.stringify(filteredChunk)}`)
    finalSlds.push(...filteredChunk)
  }
  console.log(`finalSlds length=${finalSlds.length}`, JSON.stringify(finalSlds))
  console.log('badDomains', badDomains)
  for (const [i, sldChunk] of lodash.chunk(finalSlds, 50).entries()) {
    const sortedSlds = sldChunk.sort()
    console.log(`Starting chunk ${i} for ${JSON.stringify(sortedSlds)}`)
    const batchId = `${id}-${sortedSlds[0]}-${sortedSlds[sortedSlds.length - 1]}`
    const ret = await le.createNewMultiCertificate({
      id: batchId,
      slds: sortedSlds,
      mapEntryWaitPeriod: 60,
      skipInitDns: true,
      wc: GenerateWildcard
    })
    console.log(`Finished chunk ${i}`)
    console.log(`Results: ${JSON.stringify(ret.results)}`)
    console.log('Sleeping for 60 seconds')
    await sleep(60)
  }
}

async function main () {
  const domains = []
  if (AssignedSlds.length > 0) {
    domains.push(...AssignedSlds)
  } else {
    for (let i = 97; i <= 122; i += 1) {
      chars.push(String.fromCharCode(i))
    }
    for (let i = 48; i <= 57; i += 1) {
      chars.push(String.fromCharCode(i))
    }
    const all2chars = chars.map(c1 => chars.map(c2 => `${c1}${c2}`)).flat()
    const filtered2chars = all2chars.filter(e => !Excluded.includes(e))
    const filtered1char = chars.filter(e => !Excluded.includes(e))
    // domains.push(...filtered1char, ...filtered2chars)
    domains.push(...filtered1char)
    // await batchGenerate({ slds: filtered2chars, id: 'all-2-chars-20230119' })
  }
  await batchGenerate({ slds: domains, id: CertIdPrefix })
}

main().catch(console.error)
