const AWS = require("aws-sdk");
const _ = require("underscore");
const {Semaphore} = require("async-mutex");

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


const BLOCK_LIST_ATTRS = ["index", "hash", "difficulty", "miner", "nonce", "stateRootHash", "timestamp", "totalDifficulty", "transactionCount"]
const BLOCK_FULL_ATTRS = [...BLOCK_LIST_ATTRS, "transactions"]
let client
class Fetcher {
    constructor() {
        AWS.config.update({region: process.env.region});
        client = new AWS.DynamoDB.DocumentClient();
    }
    async getBlockByHash(hash) {
        let attrs = ["index", "hash"]
        return new Promise(async (resolve, reject) => { 
            let tryQuery = () => {
                return client.query({TableName: prefix("Block"),
                IndexName: "hash-index",
                KeyConditionExpression: "#hash = :hash",
                ProjectionExpression: attrs.map(a => '#' + a).join(', '),
                ExpressionAttributeNames  : attrs.map(a => {return {['#'+a]: a}}).reduce((a,b) => {return {...a,...b}}), 
                ExpressionAttributeValues: {':hash': hash}}).promise()
            }
            try {
                let data = await tryQuery()
                resolve(this.getBlockByIndexWithTxs(data['Items'][0]['index']))
            } catch(e) {
                //retry
                setTimeout(async () => {
                    try {
                        let data = await tryQuery()
                        resolve(this.getBlockByIndexWithTxs(data['Items'][0]['index']))
                    } catch(e) {
                        reject(e)
                    }
                }, 100)
            }
        
        })
    }
    
    async getBlockByIndexWithTxs(index) {
        const block = await this.getBlockByIndex(index, BLOCK_FULL_ATTRS)
        if (block.transactions.length === 0 && block.transactionCount > 0) {
            block.transactions = await this.getTransactionsByBlock(index)
        }
        return block;
    }
    
    async getBlockByIndex(index, attrs = BLOCK_LIST_ATTRS) {
        return new Promise(async (resolve, reject) => { 
            let tryQuery = () => {
                return client.query({TableName: prefix("Block"),
                KeyConditionExpression: "#index = :index",
                ProjectionExpression: attrs.map(a => '#' + a).join(', '),
                ExpressionAttributeNames  : attrs.map(a => {return {['#'+a]: a}}).reduce((a,b) => {return {...a,...b}}), 
                ExpressionAttributeValues: {':index': index * 1}}).promise()
            }
            
            try {
                let data = await tryQuery()
                resolve(data['Items'][0])
            } catch(e) {
                //retry
                setTimeout(async () => {
                    try {
                        let data = await tryQuery()
                        resolve(data['Items'][0])
                    } catch(e) {
                        reject(e)
                    }
                }, 100)
            }
        
        })
    }
    
    async getBlocksByIndex(indexes) {
        let blocks = []
        
        await forEachSemaphore(indexes, async (index) => {
            let job = this.getBlockByIndex(index)
            blocks.push(job)
            await job
        }, 10)
        
        for (let i = 0; i < blocks.length; i++) {
            blocks[i] = await blocks[i]
        }
        
        return blocks
    }
    
    
    async getTransactionById(id) {
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

    async saveTransaction(tx) {
        await client.put({
            TableName: prefix("Transaction"),
            Item: tx
        }).promise()
    }

    async saveAccount(accounts) {
        await forEachSemaphore(accounts, async (account) => {
            try {
                await client.put({
                    TableName: prefix("Account"),
                    Item: account,
                    ConditionExpression: "attribute_not_exists(refreshBlockIndex) OR refreshBlockIndex < :newIndex",
                    ExpressionAttributeValues: {
                        ":newIndex": account.refreshBlockIndex,
                    }
                }).promise()
            } catch(e) {
                if (e.code == 'ConditionalCheckFailedException') {
                    return
                }
                throw e
            }
        }, 50)
    }

    async getTransactionsByIds(ids) {
        let txs = []
        
        await forEachSemaphore(ids, async (id) => {
            let job = this.getTransactionById(id)
            txs.push(job)
            await job
        }, 10)
        
        for (let i = 0; i < txs.length; i++) {
            txs[i] = await txs[i]
        }
        
        return txs
    }
    
    async getBlocks({after = 0, before, miner, limit = 20}) {
        limit = Math.min(Math.max(limit, 1), 100)
        if (!after) {
            after = 0
        }
        
        console.log('GET BLOCKS')
        console.time('LIST FETCH')
        let param = {}
        
        if (miner) {
            miner = miner.toLowerCase()
            param = {
                TableName: prefix("Block"),
                IndexName: "miner-index",
                KeyConditionExpression: "#miner = :miner",
                ProjectionExpression: "#index",
                ExpressionAttributeNames  : {"#miner": "miner", "#index": "index"},
                ExpressionAttributeValues: {
                    ":miner": miner,
                },
                ScanIndexForward: false,
                Limit: limit
            }
            if (before) {
                param.ExclusiveStartKey = {
                    index: Number(before),
                    miner
                }
            }
        } else {
            param = {
                TableName: prefix("Block"),
                IndexName: "block-index",
                KeyConditionExpression: "#type = :type AND #index > :after",
                ProjectionExpression: "#index",
                ExpressionAttributeNames  : {"#type": "type", "#index": "index"},
                ExpressionAttributeValues: {
                    ":type": 'B',
                    ":after": Number(after)
                },
                ScanIndexForward: false,
                Limit: limit
            }
            
            if (before) {
                param.ExclusiveStartKey = {
                    index: Number(before),
                    type: 'B'
                }
            } else { // fetch from LatestBlocks table if 1 page request
                const attrs = BLOCK_LIST_ATTRS
                let {Items} = await client.query({
                    TableName: prefix("LatestBlocks"),
                    KeyConditionExpression: "#type = :type AND #index > :after",
                    ProjectionExpression: attrs.map(a => '#' + a).join(', '),
                    ExpressionAttributeNames  : {'#type':'type', ...attrs.map(a => {return {['#'+a]: a}}).reduce((a,b) => {return {...a,...b}})}, 
                    ExpressionAttributeValues: {
                        ":type": 'B',
                        ":after": Number(after)
                    },
                    ScanIndexForward: false,
                    Limit: limit
                }).promise()
                
                if (Items.length > 0) {
                    console.timeEnd('LIST FETCH')
                    return {
                        blocks: Items,
                        before: _.last(Items).index
                    }    
                }
            }
        }
        
        let {Items, LastEvaluatedKey} = await client.query(param).promise()
        console.timeEnd('LIST FETCH')
        console.log('LIST FOUND ', Items.length)
        
        console.time('BLOCKS FETCH')
        let blocks = await this.getBlocksByIndex(Items.map(item => item.index))
        console.timeEnd('BLOCKS FETCH')
        
        let response = {blocks}
        if (LastEvaluatedKey) {
            response['before'] = LastEvaluatedKey['index']
        }
        return response;
    }
    
    async getTransactionsByBlock(blockIndex) {
        let {Items} = await client.query({TableName: prefix("Transaction"),
            IndexName: "block-index",
            KeyConditionExpression: "#blockIndex = :blockIndex",
            ExpressionAttributeNames  : {"#blockIndex": "blockIndex"},
            ExpressionAttributeValues: {":blockIndex": blockIndex * 1}}).promise()

        let transactions = await this.getTransactionsByIds(Items.map(item => item.id))
        if (transactions && transactions.length > 0) {
            return _.sortBy(transactions, tx => -tx['nonce'])
        }
        
        return []
    }
    
    async getLatestBlockIndex() {
        let {Items} = await client.query({
                TableName: prefix("Block"),
                IndexName: "block-index",
                KeyConditionExpression: "#type = :type",
                ProjectionExpression: "#index",
                ExpressionAttributeNames  : {"#type": "type", "#index": "index"},
                ExpressionAttributeValues: {
                    ":type": 'B'
                },
                ScanIndexForward: false,
                Limit: 1
            }).promise()
            
        return Items[0].index
    }
    
    async getTransactionsByActionType({action, before, limit = 20}) {
        let param = {
            TableName: prefix("Action"),
            IndexName: "typeId-blockIndex-index",
            KeyConditionExpression: "#typeId = :typeId",
            ProjectionExpression: "txIdSeq",
            ExpressionAttributeNames  : {"#typeId": "typeId"},
            ExpressionAttributeValues: {
                ":typeId": action
            },
            ScanIndexForward: false,
            Limit: limit
        }
        if (before) {
            let {Items} = await client.query({
                TableName: prefix("Action"),
                KeyConditionExpression: "#txIdSeq = :before",
                ProjectionExpression: "txIdSeq, blockIndex, typeId",
                ExpressionAttributeNames  : {"#txIdSeq": "txIdSeq"},
                ExpressionAttributeValues: {
                    ":before": before
                }
            }).promise()
            
            if (Items && Items[0]) {
                param.ExclusiveStartKey = Items[0]
            }
        }
        
        let {Items, LastEvaluatedKey} = await client.query(param).promise()
        
        let response = {}
        let txIds = Items.map(item => item.txIdSeq.split('/')[0])
        
        let transactions = await this.getTransactionsByIds(txIds)
        
        response['transactions'] = transactions
        if (LastEvaluatedKey) {
            response['before'] = LastEvaluatedKey['txIdSeq']
        }
        
        return response
    }
    
    async getTransactions({before, limit = 20}) {
        let blockId, skip
        if (before) {
            let split = before.split('/')
            blockId = Number(split[0])
            if (split[1]) {
                skip = Number(split[1])
            } else {
                blockId -= 1
            }
        } else {
            blockId = await this.getLatestBlockIndex()
        }

        let transactions = []
        for (let i = 0; i < 20; i++) {
            let txs = await this.getTransactionsByBlock(blockId - i)
            if (i == 0 && skip) {
                txs = txs.slice(skip)
            }
            
            if (transactions.length + txs.length <= limit) {
                transactions.push(...txs)
                
                if (transactions.length == limit) {
                    return {
                        transactions,
                        before: blockId - i
                    }
                }
            } else {
                let _txs = txs.slice(0, limit - transactions.length)
                transactions.push(..._txs)
                if (i == 0 && skip) {
                    skip += _txs.length
                } else {
                    skip = _txs.length
                }
                return {
                    transactions,
                    before: (blockId - i) + '/' + skip
                }
            }
        }
        
        return {transactions, before: blockId - 20}
    }
    
    async countAccountTransactions(account) {
        let param = {
            TableName: prefix("AccountTransaction"),
            IndexName: "address-index",
            KeyConditionExpression: "address = :account",
            ExpressionAttributeValues: {
                ":account": account,
            },
            Select: 'COUNT',
            Limit:1000
        }
        return await client.query(param).promise()
    }
    async getInvolvedTransactions({account, action, before, limit=20}) {
        let param = {
            TableName: prefix("AccountTransaction"),
            IndexName: "address-index",
            KeyConditionExpression: "address = :account",
            ExpressionAttributeValues: {
                ":account": account,
            },
            ScanIndexForward: false,
            Limit: limit
        }
        
        if (before) {
            param.ExclusiveStartKey = {
                blockIndex: Number(before.split('/')[0]),
                pk: before.split('/')[1],
                address: account
            }
        }
        
        if (action) {
            param = {
                TableName: prefix("AccountTransaction"),
                IndexName: "action-index",
                KeyConditionExpression: "addressWithType = :key",
                ExpressionAttributeValues: {
                    ":key": account + '#' + action,
                },
                ScanIndexForward: false,
                Limit: limit
            }
            
            if (before) {
                param.ExclusiveStartKey = {
                    blockIndex: Number(before.split('/')[0]),
                    pk: before.split('/')[1],
                    addressWithType: account + '#' + action
                }
            }
        }
        
        console.time('LIST FETCH')
        let {Items, LastEvaluatedKey} = await client.query(param).promise()
        console.timeEnd('LIST FETCH')
        console.log('LIST FOUND ', Items.length, LastEvaluatedKey)
        
        console.time('TXS FETCH')
        let transactions = await this.getTransactionsByIds(Items.map(item => item.txId))
        console.timeEnd('TXS FETCH')
        
        transactions.forEach(tx => {
            let item = Items.find(item => item.txId == tx.id)
            if (item) {
                tx['involved'] = {type: item['type'], updated: item['accountUpdated']}
            }
        })
        
        let response = {transactions}
        if (LastEvaluatedKey) {
            response['before'] = LastEvaluatedKey['blockIndex'] + '/' + LastEvaluatedKey['pk']
        }
        return response
    }

    async searchAvatarsByName(avatarName) {
        let param = {
            TableName: prefix("Account"),
            IndexName: "avatarname-index",
            KeyConditionExpression: "#type = :type AND begins_with(#name, :name)",
            ExpressionAttributeNames  : {"#type": "type", "#name": "avatarName"},
            ExpressionAttributeValues: {
                ":type": 'AVATAR',
                ":name": avatarName
            },
            ScanIndexForward: false,
            Limit: 20
        }

        let {Items} = await client.query(param).promise()
        return Items
    }

    async getAccountStatesByAvatar(avatarAddress) {
        let param = {
            TableName: prefix("Account"),
            IndexName: "avatar-index",
            KeyConditionExpression: "avatarAddress = :address",
            ExpressionAttributeValues: {
                ":address": avatarAddress,
            },
            ScanIndexForward: false,
            Limit: 1
        }
        
        let {Items} = await client.query(param).promise()
        console.log(Items)
        if (Items && Items[0] && Items[0].address) {
            return await this.getAccountStates(Items[0].address)
        }
        return null
    }
    
    async getAccountStates(address) {
        let param = {
            TableName: prefix("Account"),
            KeyConditionExpression: "address = :address",
            ExpressionAttributeValues: {
                ":address": address.toLowerCase(),
            },
            ScanIndexForward: false,
            Limit: 100
        }
        
        let {Items} = await client.query(param).promise()

        //filter the latest only
        const maxRefreshBlockIndex = _.max(
          Items.filter(({refreshBlockIndex}) => refreshBlockIndex),
          ({refreshBlockIndex}) => refreshBlockIndex
        )['refreshBlockIndex']

        return Items.filter(({refreshBlockIndex}) => refreshBlockIndex === maxRefreshBlockIndex)
    }

    async getShopHistory({itemSubType, grade, from, to, ticker, itemId, options, level, before, limit = 20}) {
        let param = {
            TableName: prefix("ShopHistory"),
            IndexName: "block-index",
            KeyConditionExpression: "#type = :type",
            ExpressionAttributeNames  : {"#type": "type"},
            ExpressionAttributeValues: {
                ":type": 'BUY'
            },
            ScanIndexForward: false,
            Limit: limit
        }

        if (itemSubType) {
            if (grade) {
                if (options && level) {
                    param = {
                        ...param,
                        IndexName: "itemSubType-grade-level-options-index",
                        KeyConditionExpression: "#key = :value",
                        ExpressionAttributeNames  : {"#key": "itemSubType_grade_level_options"},
                        ExpressionAttributeValues: {":value": `${itemSubType}_${grade}_${level}_${options}`},
                    }
                } else if (options) {
                    param = {
                        ...param,
                        IndexName: "itemSubType-grade-options-index",
                        KeyConditionExpression: "#key = :value",
                        ExpressionAttributeNames  : {"#key": "itemSubType_grade_options"},
                        ExpressionAttributeValues: {":value": `${itemSubType}_${grade}_${options}`},
                    }
                } else if (level) {
                    param = {
                        ...param,
                        IndexName: "itemSubType-grade-level-index",
                        KeyConditionExpression: "#key = :value",
                        ExpressionAttributeNames  : {"#key": "itemSubType_grade_level"},
                        ExpressionAttributeValues: {":value": `${itemSubType}_${grade}_${level}`},
                    }
                } else {
                    param = {
                        ...param,
                        IndexName: "itemSubType-grade-index",
                        KeyConditionExpression: "#key = :value",
                        ExpressionAttributeNames  : {"#key": "itemSubType_grade"},
                        ExpressionAttributeValues: {":value": `${itemSubType}_${grade}`},
                    }
                }
            } else {
                param = {
                    ...param,
                    IndexName: "itemSubType-index",
                    KeyConditionExpression: "#key = :value",
                    ExpressionAttributeNames  : {"#key": "itemSubType"},
                    ExpressionAttributeValues: {":value": Number(itemSubType)},
                }
            }
        } else if (itemId) {
            if (options && level) {
                param = {
                    ...param,
                    IndexName: "itemId-level-options-index",
                    KeyConditionExpression: "#key = :value",
                    ExpressionAttributeNames  : {"#key": "itemId_level_options"},
                    ExpressionAttributeValues: {":value": `${itemId}_${level}_${options}`},
                }
            } else if (options) {
                param = {
                    ...param,
                    IndexName: "itemId-options-index",
                    KeyConditionExpression: "#key = :value",
                    ExpressionAttributeNames  : {"#key": "itemId_options"},
                    ExpressionAttributeValues: {":value": `${itemId}_${options}`},
                }
            } else if (level) {
                param = {
                    ...param,
                    IndexName: "itemId-level-index",
                    KeyConditionExpression: "#key = :value",
                    ExpressionAttributeNames  : {"#key": "itemId_level"},
                    ExpressionAttributeValues: {":value": `${itemId}_${level}`},
                }
            } else {
                param = {
                    ...param,
                    IndexName: "itemId-index",
                    KeyConditionExpression: "#key = :value",
                    ExpressionAttributeNames  : {"#key": "itemId"},
                    ExpressionAttributeValues: {":value": Number(itemId)},
                }
            }
        } else if (ticker) {
            param = {
                ...param,
                IndexName: "ticker-index",
                KeyConditionExpression: "#key = :value",
                ExpressionAttributeNames  : {"#key": "ticker"},
                ExpressionAttributeValues: {":value": ticker},
            }
        } else if (from) {
            param = {
                ...param,
                IndexName: "from-index",
                KeyConditionExpression: "#key = :value",
                ExpressionAttributeNames  : {"#key": "from"},
                ExpressionAttributeValues: {":value": from},
            }
        } else if (to) {
            param = {
                ...param,
                IndexName: "to-index",
                KeyConditionExpression: "#key = :value",
                ExpressionAttributeNames  : {"#key": "to"},
                ExpressionAttributeValues: {":value": to},
            }
        }

        if (before) {
            param['ExclusiveStartKey'] = JSON.parse(before)
        }

        let {Items, LastEvaluatedKey} = await client.query(param).promise()

        let response = {}
        let txIds = Items.map(item => item.txId)

        let historyItems = await this.getShopHistoryByTxs(txIds)

        response['items'] = historyItems
        if (LastEvaluatedKey) {
            response['before'] = JSON.stringify(LastEvaluatedKey)
        }

        return response
    }

    async getShopHistoryByTxs(ids) {
        let txs = []

        await forEachSemaphore(ids, async (id) => {
            let job = this.getShopHistoryByTx(id)
            txs.push(job)
            await job
        }, 10)

        for (let i = 0; i < txs.length; i++) {
            txs[i] = await txs[i]
        }

        return txs
    }

    async getShopHistoryByTx(id) {
        return new Promise(async (resolve, reject) => {
            try {
                let data = await client.query({TableName: prefix("ShopHistory"), KeyConditionExpression: "#id = :id", ExpressionAttributeNames  : {"#id": "txId"}, ExpressionAttributeValues: {":id": id.toLowerCase()}}).promise()
                resolve(data['Items'][0])
            } catch(e) {
                //retry
                setTimeout(async () => {
                    try {
                        let data = await client.query({TableName: prefix("ShopHistory"), KeyConditionExpression: "#id = :id", ExpressionAttributeNames  : {"#id": "txId"}, ExpressionAttributeValues: {":id": id.toLowerCase()}}).promise()
                        resolve(data['Items'][0])
                    } catch(e) {
                        reject(e)
                    }
                }, 100)
            }

        })
    }

    async getCahceWithChunk(cacheKey, chunkSize = 200000) {
        const baseCache = await this.getCache(cacheKey);
        if (!baseCache) {
            return null
        }

        const chunkIndex = new Array(baseCache.value).fill(0).map((_, i) => i)
        let data = '';
        for (let i = 0; i < chunkIndex.length; i += chunkSize) {
            const chunk = await this.getCache(`${cacheKey}-${i}`);
            if (!chunk) {
                return null
            }
            data += chunk.value;
        }
        return JSON.parse(data);
    }

    async setCacheWithChunk(cacheKey, data, chunkSize = 200000) {
        const dataString = JSON.stringify(data);
        const chunkCount = Math.ceil(dataString.length / chunkSize);
        await this.setCache(cacheKey, {value: chunkCount});
        for (let i = 0; i < chunkCount; i++) {
            await this.setCache(`${cacheKey}-${i}`, {value: dataString.slice(i * chunkSize, (i + 1) * chunkSize)});
        }
    }
    async getCache(cacheKey) {
        let {Items} = await client.query({
            TableName: prefix("Cache"),
            KeyConditionExpression: "cacheKey = :cacheKey",
            ExpressionAttributeValues: {
                ":cacheKey": cacheKey,
            },
            Limit: 1
        }).promise()
        
        return Items && Items[0]
    }
    
    async setCache(cacheKey, data) {
        await client.put({
            TableName: prefix("Cache"),
            Item: {
                cacheKey,
                ...data
            }
        }).promise()
    }
}


module.exports = new Fetcher()