require('dotenv').config()
const Datastore = require('../src/data/datastore')
const fs = require('fs/promises')
const ds = Datastore.client()
const readline = require('readline')
const { Purchase } = require('../src/data/purchase')
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const OUT = process.env.OUT

const Fetcher = ({ client = ds, kind, next, sync, filter, batchSize = 100 }) => {
  const buildListQuery = (cursor) => {
    let q = client.createQuery(kind).limit(batchSize)
    if (filter) {
      q = q.filter(...filter)
    }
    if (cursor) {
      return q.start(cursor)
    }
    return q
  }
  return async (totalSize = 0) => {
    const exec = async ({ cursor, currentSize = 0 }) => {
      const listQuery = buildListQuery(cursor)
      const results = await client.runQuery(listQuery)
      const entities = results[0]
      const info = results[1]
      if (next) {
        if (sync) {
          await next(entities)
        } else {
          next(entities)
        }
      }
      if (info.moreResults === client.NO_MORE_RESULTS) {
        return entities
      }
      if (totalSize > 0 && (currentSize + entities.length >= totalSize)) {
        return entities
      }
      const more = await exec({ cursor: info.endCursor, currentSize: currentSize + entities.length })
      return entities.concat(more)
    }
    return exec({})
  }
}

async function main () {
  // const filter = ['updateTime', '>', 0]
  const filter = null
  const entries = []
  const next = async (entities) => {
    if (!entities?.length) {
      return
    }
    const records = entities.map(({ address, id }) => ({ address, id }))
    entries.push(...records)
    console.log(`-- From: ${records[0].id}, Until at: ${records[records.length - 1].id}`)
  }
  const fetcher = Fetcher({ kind: Purchase.kind, next, filter, sync: true, batchSize: 25 })
  await fetcher(0)
  console.log(`Finished fetching ${entries.length} entries`)
  const out = entries.map(({ address, id }) => `${address} ${id}`).join('\n')
  await fs.writeFile(OUT, out, { encoding: 'utf-8' })
  console.log(`Wrote to ${OUT}`)
}

const hang = () => {
  rl.question('Type "exit" and press enter to exit: ', response => {
    if (response === 'exit') {
      console.log(response)
      rl.close()
      process.exit(0)
    }
    hang()
  })
}

hang()
main().catch(ex => console.error(ex))
