const Redis = require('redis')
const config = require('../config')

let redisClient

const init = async () => {
  if (redisClient) {
    return
  }
  redisClient = Redis.createClient({ url: config.redis.url })
  await redisClient.connect()
  return redisClient.isReady
}

const newInstance = async (url) => {
  const client = Redis.createClient({ url })
  await client.connect()
  return client
}

const test = async () => {
  const testRes = await redisClient.keys('*')
  console.log(testRes)
}

init().then(() => {
  console.log('Initialized Redis')
}).catch(() => {
  console.log('Can\'t init Redis')
  process.exit(1)
})

module.exports = { redisClient, test, newInstance }
