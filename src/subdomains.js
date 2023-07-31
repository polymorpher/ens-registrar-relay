const { redisClient } = require('./redis')
const config = require('../config')
const w3utils = require('./w3utils')
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

const verifyMessage = ({ signature, addresses, subdomain, deleteRecord, sld, targetDomain, deadline }) => {
  let message = `I want to map subdomain ${subdomain}.${sld}.${config.tld} to ${targetDomain}. This operation has to complete by timestamp ${deadline}`
  if (deleteRecord) {
    message = `I want to delete subdomain mapping for ${subdomain}.${sld}.${config.tld}. This operation has to complete by timestamp ${deadline}`
  }
  const ra = w3utils.utils.ecrecover(message, signature)
  return addresses.map(a => a.toLowerCase()).includes(ra)
}

const verifyRedirect = ({ signature, addresses, fullUrl, deleteRecord, target, deadline }) => {
  let message = `I want to map ${fullUrl} to ${target}. This operation has to complete by timestamp ${deadline}`
  if (deleteRecord) {
    message = `I want to delete mapping for ${fullUrl}. This operation has to complete by timestamp ${deadline}`
  }
  const ra = w3utils.utils.ecrecover(message, signature)
  return addresses.map(a => a.toLowerCase()).includes(ra)
}

const setCname = async ({ subdomain, sld, targetDomain }) => {
  if (!subdomain || subdomain === '@' || subdomain === 'mail') {
    throw new Error(`Subdomain ${subdomain} is reserved`)
  }
  const zone = `${sld}.${config.tld}.`
  const fqdn = (!targetDomain || targetDomain.endsWith('.')) ? targetDomain : `${targetDomain}.`
  if (!targetDomain) {
    const record = await redisClient.hGet(zone, subdomain)
    if (!record) {
      throw new Error(`Cannot remove ${subdomain} under ${sld} - no record exists`)
    }
    const parsedRecord = JSON.parse(record)
    const keys = Object.keys(parsedRecord)
    if (keys.length > 1 || keys[0] !== 'cname') {
      throw new Error(`Cannot remove ${subdomain} under ${sld} - other records exists: ${keys} `)
    }
    const res = await redisClient.hDel(zone, subdomain)
    console.log(`-setCname remove ${subdomain} under ${sld}`, 'redis response: ', res)
    return res
  } else {
    const res = await redisClient.hSet(zone, subdomain, JSON.stringify({
      cname: [{ host: fqdn, ttl: 300 }]
    }))
    console.log(`-setCname of ${subdomain} under ${sld} to ${fqdn}`, 'redis response: ', res)
    return res
  }
}

module.exports = { enableSubdomains, getWildcardSubdomainRecord, verifyMessage, setCname, verifyRedirect }
