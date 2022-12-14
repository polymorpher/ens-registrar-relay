const Web3 = require('web3')
const abi = require('web3-eth-abi')
// const crypto = require('crypto')
const createKeccakHash = require('keccak')
const config = require('../config')
const web3 = new Web3(config.provider)
// const AbiRegistrarController = require('../abi/RegistrarController.json')
// const Contract = require('web3-eth-contract')
// Contract.setProvider(web3.currentProvider)

const utils = {
  hexView: (bytes) => {
    return bytes && Array.from(bytes).map(x => x.toString(16).padStart(2, '0')).join('')
  },

  hexString: (bytes) => {
    return '0x' + utils.hexView(bytes)
  },

  keccak: (bytes) => {
    const k = createKeccakHash('keccak256')
    // assume Buffer is poly-filled or loaded from https://github.com/feross/buffer
    const hash = k.update(Buffer.from(bytes)).digest()
    return new Uint8Array(hash)
  },

  stringToBytes: str => {
    return new TextEncoder().encode(str)
  },

  keccak256: (str, use0x) => {
    const bytes = utils.stringToBytes(str)
    const hash = utils.keccak(bytes)
    return use0x ? utils.hexString(hash) : utils.hexView(hash)
  },

  hexToBytes: (hex, length, padRight) => {
    if (!hex) {
      return
    }
    length = length || hex.length / 2
    const ar = new Uint8Array(length)
    for (let i = 0; i < hex.length / 2; i += 1) {
      let j = i
      if (padRight) {
        j = length - hex.length + i
      }
      ar[j] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return ar
  },

  hexStringToBytes: (hexStr, length) => {
    return hexStr.startsWith('0x') ? utils.hexToBytes(hexStr.slice(2), length) : utils.hexToBytes(hexStr, length)
  },

  tryNormalizeAddress: (address) => {
    try {
      return web3.utils.toChecksumAddress((address || '').toLowerCase())
    } catch (ex) {
      console.error(ex)
      return null
    }
  },

  ecrecover: (message, signature) => {
    try {
      return web3.eth.accounts.recover(message, signature)
    } catch (ex) {
      console.error(ex)
      return null
    }
  },
}

// event NameRegistered(
//   string name,
//   bytes32 indexed label,
//   address indexed owner,
//   uint256 baseCost,
//   uint256 premium,
//   uint256 expires
// );

const TOPIC_NAME_REGISTRATION = utils.keccak256('NameRegistered(string,bytes32,address,uint256,uint256,uint256)', true)

const parseNameRegistrationData = (data) => {
  const decoded = abi.decodeParameters(['string', 'uint256', 'uint256', 'uint256'], data)
  return {
    name: decoded[0],
    baseCost: decoded[1],
    premium: decoded[2],
    expires: decoded[3],
  }
}

const parseNameRegistrationLog = (log) => {
  console.log('log', JSON.stringify(log))
  const regTopic = log?.topics?.find(e => e === TOPIC_NAME_REGISTRATION)
  console.log('regTopic', JSON.stringify(regTopic))
  const owner = log?.topics?.[2]
  if (!regTopic || !owner) {
    return null
  }
  return {
    owner: '0x' + owner.slice(26),
    ...parseNameRegistrationData(log?.data)
  }
}

const getDomainRegistrationEvent = async (txHash) => {
  // const c = new web3.eth.Contract(AbiRegistrarController, config.registrarController)
  const txr = await web3.eth.getTransactionReceipt(txHash)
  console.log('txr', JSON.stringify(txr))
  const filteredLogs = txr?.logs.filter(e => e?.address?.toLowerCase() === config.registrarController.toLowerCase())
  if (!filteredLogs?.length > 0) {
    return null
  }
  const regLogs = filteredLogs.map(parseNameRegistrationLog).filter(e => e)
  return regLogs?.[0]
}

module.exports = { utils, getDomainRegistrationEvent, parseNameRegistrationLog, parseNameRegistrationData, TOPIC_NAME_REGISTRATION }
