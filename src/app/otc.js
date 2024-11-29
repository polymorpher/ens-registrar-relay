const { redisClient } = require('../redis')
const config = require('../../config')

const isOtcEnabled = async ({ sld }) => {
  const zone = `${sld}.${config.tld}.`
  const key = '@'
  const v = await redisClient.hGet(zone, key)
  try {
    const record = JSON.parse(v)
    return record?.a?.[0]?.ip === config.app.otc.frontendServerIp
  } catch (ex) {
    console.error(`[isOtcEnabled][${sld}]`, ex)
    return false
  }
}

const enableOtc = async ({ sld }) => {
  const zone = `${sld}.${config.tld}.`
  const key = '@'
  const v = await redisClient.hGet(zone, key)
  try {
    const record = JSON.parse(v)
    const newRecord = { ...record, a: [{ ttl: 300, ip: config.app.otc.frontendServerIp }] }
    const res = await redisClient.hSet(zone, key, JSON.stringify(newRecord))
    console.log(`- enableOtc ${sld}`, 'redis response: ', res)
    return true
  } catch (ex) {
    console.error(`[enableOtc][${sld}]`, ex)
    return false
  }
}

module.exports = { enableOtc, isOtcEnabled }
