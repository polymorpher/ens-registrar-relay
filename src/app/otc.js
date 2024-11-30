const { redisClient } = require('../redis')
const config = require('../../config')
const abi = require('web3-eth-abi')
const { utils, web3 } = require('../w3utils')
const { StatusCodes } = require('http-status-codes')
const appConfig = require('../../config')

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

// event OfferCreated(
//   string indexed domainName,
//   address indexed srcAsset,
//   address indexed destAsset,
//   address offerAddress,
//   address domainOwner,
//   uint256 depositAmount,
//   uint256 closeAmount,
//   uint256 commissionRate,
//   uint256 lockWithdrawAfter
// );

const TOPIC_OFFER_CREATED = utils.keccak256('OfferCreated(string,address,address,address,address,uint256,uint256,uint256,uint256)', true)

const parseOfferCreatedData = (data) => {
  const decoded = abi.decodeParameters(['string', 'address', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'], data)
  return {
    domainName: decoded[0],
    srcAsset: decoded[1],
    destAsset: decoded[2],
    offerAddress: decoded[3],
    domainOwner: decoded[4],
    depositAmount: decoded[5],
    closeAmount: decoded[6],
    commissionRate: decoded[7],
    lockWithdrawAfter: decoded[8],
  }
}

const parseOfferCreatedLog = (log) => {
  // console.log('log', JSON.stringify(log))
  const regTopic = log?.topics?.find(e => e === TOPIC_OFFER_CREATED)
  // console.log('regTopic', JSON.stringify(regTopic))
  const owner = log?.topics?.[2]
  if (!regTopic || !owner) {
    return null
  }
  return {
    owner: '0x' + owner.slice(26),
    ...parseOfferCreatedData(log?.data)
  }
}

const getOfferCreatedEvent = async (txHash) => {
  // const c = new Contract(AbiRegistrarController, config.registrarController)
  const txr = await web3.eth.getTransactionReceipt(txHash)
  // console.log('txr', JSON.stringify(txr))
  const filteredLogs = txr?.logs.filter(e => e?.address?.toLowerCase() === config.app.otc.contract.toLowerCase())
  if (!filteredLogs?.length > 0) {
    return null
  }
  const regLogs = filteredLogs.map(parseOfferCreatedLog).filter(e => e)
  return regLogs?.[0]
}

const checkOfferCreatedEvent = async ({ txHash, domain, res }) => {
  const event = await getOfferCreatedEvent(txHash)
  if (!event) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'did not find offer created event in txHash', txHash })
    return false
  }
  const { domainName } = event
  if (`${domainName}.${appConfig.tld}` !== domain) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'offer created event domain does not match provided domain',
      eventDomain: `${domainName}.${appConfig.tld}`,
      providedDomain: domain
    })
    return false
  }
  return true
}

module.exports = { getOfferCreatedEvent, isOtcEnabled, enableOtc, checkOfferCreatedEvent }
