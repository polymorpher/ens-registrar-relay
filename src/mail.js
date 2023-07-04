const { redisClient } = require('./redis')
const config = require('../config')

const isMailEnabled = async ({ sld }) => {
  const zone = `${sld}.${config.tld}.`
  const key = 'mail'
  const v = await redisClient.hGet(zone, key)
  try {
    const record = JSON.parse(v)
    return record?.a?.[0]?.ip === config.easIp
  } catch (ex) {
    console.error(`[isMailEnabled][${sld}]`, ex)
    return false
  }
}
const enableMail = async ({ sld }) => {
  const zone = `${sld}.${config.tld}.`
  const key = 'mail'
  const newRecord = { a: [{ ttl: 300, ip: config.easIp }] }
  const res = await redisClient.hSet(zone, key, JSON.stringify(newRecord))
  console.log(`-enableMail ${sld}`, 'redis response: ', res)
}

module.exports = { enableMail, isMailEnabled }
