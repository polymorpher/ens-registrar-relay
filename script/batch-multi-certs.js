const gcp = require('../src/gcp-certs')
const le = require('../src/letsencrypt-certs')
const lodash = require('lodash')
const { sleep } = require('../src/utils')

const chars = []

async function batchGenerate ({ slds, id }) {
  console.log(`generating certs for ${slds.length} slds: ${JSON.stringify(slds)}`)
  const finalSlds = []
  for (const chunk of lodash.chunk(slds, 250)) {
    const filtered = await gcp.filterSldsWithoutCert({ slds: chunk })
    console.log(`added ${filtered.length} slds: ${JSON.stringify(filtered)}`)
    // await Promise.all(chunk.map(domain => le.setInitialDNS({ domain })))
    finalSlds.push(...filtered)
    console.log('Sleeping for 30 seconds')
    await sleep(30)
  }
  console.log('finalSlds', JSON.stringify(finalSlds))
  for (const [i, sldChunk] of lodash.chunk(finalSlds, 50).entries()) {
    console.log(`Starting chunk ${i} for ${JSON.stringify(sldChunk)}`)
    const batchId = i > 0 ? `${id}-${i}` : id
    const ret = await le.createNewMultiCertificate({ id: batchId, slds: sldChunk, mapEntryWaitPeriod: 10 })
    console.log(`Finished chunk ${i}`)
    console.log(`Results: ${JSON.stringify(ret.results)}`)
    console.log('Sleeping for 60 seconds')
    await sleep(60)
  }
}

const Excluded = ['li', 'ml', 'ba', 'ec', 'au']
async function main () {
  for (let i = 97; i <= 122; i += 1) {
    chars.push(String.fromCharCode(i))
  }
  for (let i = 48; i <= 57; i += 1) {
    chars.push(String.fromCharCode(i))
  }
  const all2chars = chars.map(c1 => chars.map(c2 => `${c1}${c2}`)).flat()
  const filtered2chars = all2chars.filter(e => !Excluded.includes(e))
  await batchGenerate({ slds: filtered2chars, id: 'all-2-chars' })
}

main().catch(console.error)
