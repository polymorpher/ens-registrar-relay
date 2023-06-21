const gcp = require('../src/gcp-certs')
const le = require('../src/letsencrypt-certs')
const lodash = require('lodash')
const { sleep } = require('../src/utils')

const chars = []

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
  const finalSlds = await gcp.filterSldsWithoutCert({ slds, checkWc: false })
  console.log(`finalSlds length=${finalSlds.length}`, JSON.stringify(finalSlds))
  for (const [i, sldChunk] of lodash.chunk(finalSlds, 50).entries()) {
    const sortedSlds = sldChunk.sort()
    console.log(`Starting chunk ${i} for ${JSON.stringify(sortedSlds)}`)
    const batchId = `${id}-${sortedSlds[0]}-${sortedSlds[sortedSlds.length - 1]}`
    const ret = await le.createNewMultiCertificate({ id: batchId, slds: sortedSlds, mapEntryWaitPeriod: 60, skipInitDns: true, wc: false })
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
