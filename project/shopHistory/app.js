const AWS = require("aws-sdk")
const axios = require("axios")
const _ = require("underscore");
const {Semaphore} = require("async-mutex");

AWS.config.update({region: process.env.region});
const client = new AWS.DynamoDB.DocumentClient()
const MARKET_API = process.env.marketAPI

function prefix(name) {
  let prefix = process.env.tablePrefix
  if (prefix) {
    return `${prefix}.${name}`
  }
  return name
}

async function forEachSemaphore(items, fn, limit) {
  let sem = new Semaphore(limit)
  let promises = []
  for (let item of items) {
    promises.push(sem.runExclusive(async () => {
      return new Promise(async (resolve) => {
        try {
          await fn(item)
        } catch(e) {
          console.log(e)
        } finally {
          resolve()
        }
      })
    }))
  }

  await Promise.all(promises)
}

function hexStringToGUID(hexString) {
  const bytes = hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16));
  function bytesToGUID(bytes) {
    const parts = [
      bytes.slice(0, 4).reverse(), // 첫 4바이트 (역순)
      bytes.slice(4, 6).reverse(), // 다음 2바이트 (역순)
      bytes.slice(6, 8).reverse(), // 다음 2바이트 (역순)
      bytes.slice(8, 10),          // 다음 2바이트
      bytes.slice(10)              // 마지막 6바이트
    ];

    return parts.map(part => part.map(b => b.toString(16).padStart(2, '0')).join('')).join('-');
  }

  return bytesToGUID(bytes);
}

async function getTransactions(blockIndex) {
  let {Items} = await client.query({TableName: prefix("Transaction"),
    IndexName: "block-index",
    KeyConditionExpression: "#blockIndex = :blockIndex",
    ExpressionAttributeNames  : {"#blockIndex": "blockIndex"},
    ExpressionAttributeValues: {":blockIndex": blockIndex * 1}}).promise()

  let txs = []

  await forEachSemaphore(Items.map(item => item.id), async (id) => {
    let job = getTransactionById(id)
    txs.push(job)
    await job
  }, 10)

  for (let i = 0; i < txs.length; i++) {
    txs[i] = await txs[i]
  }

  return txs
}

async function getTransactionById(id) {
  return new Promise(async (resolve, reject) => {
    try {
      let data = await client.query({TableName: prefix("Transaction"), KeyConditionExpression: "#id = :id", ExpressionAttributeNames  : {"#id": "id"}, ExpressionAttributeValues: {":id": id.toLowerCase()}}).promise()
      resolve(data['Items'][0])
    } catch(e) {
      //retry
      setTimeout(async () => {
        try {
          let data = await client.query({TableName: prefix("Transaction"), KeyConditionExpression: "#id = :id", ExpressionAttributeNames  : {"#id": "id"}, ExpressionAttributeValues: {":id": id.toLowerCase()}}).promise()
          resolve(data['Items'][0])
        } catch(e) {
          reject(e)
        }
      }, 100)
    }

  })
}

async function saveShopHistory(items) {
  console.log(`save ${items.length} bought items`)
  await forEachSemaphore(items, async (item) => {
    await client.put({
      TableName: prefix("ShopHistory"),
      Item: item
    }).promise()
  }, 50)
}

async function syncBlock(blockIndex) {
  const txs = await getTransactions(blockIndex)
  const guids = Array.of()
  const guidTxMap = new Object({})
  for (const tx of txs.filter(tx => tx.actions.find(a => a['typeId'].startsWith('buy_product')))) {
    const action = tx.actions[0]
    const {values} = JSON.parse(action['inspection']
      .replace(/\,(?!\s*?[\{\[\"\'\w])/g, '')
      .replace(/[\n\r]/gi, '')
      .replace(/b"([\\x0-9a-fA-F]+?)"/g, function(_, v) { return '"0x' + v.replace(/\\x/g, '') + '"' }))

    if (values && values['p']) {
      for (const product of values['p']) {
        const itemIdHex = product[0]
        const buyerAgent = tx.signer
        const buyerAvatar = values['a']
        const sellerAgent = product[2]
        const sellerAvatar = product[3]
        const itemGuid = hexStringToGUID(itemIdHex.substring(2))
        guidTxMap[itemGuid] = {
          ...tx,
          buyerAgent,
          buyerAvatar,
          sellerAgent,
          sellerAvatar
        }
        guids.push(itemGuid)
      }
    }
  }

  if (guids.length > 0) {
    const {data} = await axios.get(MARKET_API + '/Market/products?' + guids.map(guid => `productIds=${guid}`).join('&'))
    const records = Array.of()
    for (const item of data.itemProducts) {
      const tx = guidTxMap[item.productId]
      const options = `${item.statModels.length-1}+${item.skillModels.length}`
      const record = {
        type: 'BUY',
        txId: tx.id,
        from: tx.sellerAgent,
        fromAvatar: tx.sellerAvatar,
        to: tx.buyerAgent,
        toAvatar: tx.buyerAvatar,
        blockIndex: tx.blockIndex,
        blockTime: tx.blockTimestamp,
        itemSubType: item.itemSubType,
        itemSubType_grade: `${item.itemSubType}_${item.grade}`,
        itemSubType_grade_level: `${item.itemSubType}_${item.grade}_${item.level}`,
        itemSubType_grade_options: `${item.itemSubType}_${item.grade}_${options}`,
        itemSubType_grade_level_options: `${item.itemSubType}_${item.grade}_${item.level}_${options}`,
        itemId: item.itemId,
        itemId_level: `${item.itemId}_${item.level}`,
        itemId_options: `${item.itemId}_${options}`,
        itemId_level_options: `${item.itemId}_${item.level}_${options}`,
        item
      }
      records.push(record)
    }
    for (const item of data.fungibleAssetValueProducts) {
      const tx = guidTxMap[item.productId]
      const record = {
        type: 'BUY',
        txId: tx.id,
        from: tx.sellerAgent,
        fromAvatar: tx.sellerAvatar,
        to: tx.buyerAgent,
        toAvatar: tx.buyerAvatar,
        blockIndex: tx.blockIndex,
        blockTime: tx.blockTimestamp,
        ticker: item.ticker,
        item
      }
      records.push(record)
    }

    if (records.length > 0) {
      await saveShopHistory(records)
    }
  }
}

module.exports = syncBlock