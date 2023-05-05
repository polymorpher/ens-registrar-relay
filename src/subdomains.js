const { redisClient } = require('./redis')
const config = require('../config')
const enableSubdomains = async ({ sld }) => {
  const zone = `${sld}.${config.tld}.`
  const key = '*'
  const newRecord = { a: [{ ttl: 300, ip: config.ewsIp }] }
  const res = await redisClient.hSet(zone, key, JSON.stringify(newRecord))
  console.log(`-enableSubdomains ${sld}`, 'redis response: ', res)
}

const getWildcardSubdomainRecord = async ({ sld }) => {
  const zone = `${sld}.${config.tld}.`
  const key = '*'
  const res = await redisClient.hGet(zone, key)
  console.log(`-getWildcardSubdomainRecord ${sld}`, 'redis response: ', res)
  return res
}

module.exports = { enableSubdomains, getWildcardSubdomainRecord }
