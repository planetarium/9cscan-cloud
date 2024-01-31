const AWS = require("aws-sdk")
const _ = require("underscore")
const { forEachSemaphore, parseAction } = require("../utils/utils")

function prefix(name) {
    let prefix = process.env.tablePrefix
    if (prefix) {
        return `${prefix}.${name}`
    }
    return name
}


class DynamoRepository {
    constructor() {
        AWS.config.update({region:process.env.region || 'ap-northeast-2'});
        this.client = new AWS.DynamoDB.DocumentClient();
    }
    async getTotalCount(query) {
        let resultCount = 0
        for (let i = 0; i < 20; i++) {
            let {Count, LastEvaluatedKey} = await this.client.query(query).promise()
            resultCount += Count
            if (LastEvaluatedKey) {
                query['ExclusiveStartKey'] = LastEvaluatedKey
            } else {
                break
            }
        }
        return resultCount
    }
    async getLastBlockIndex() {
        const {Items} = await this.client.query({
            TableName: prefix("Block"),
            IndexName: "block-index",
            KeyConditionExpression: "#type = :type",
            ProjectionExpression: "#index",
            ExpressionAttributeNames  : {"#index": "index", "#type": "type"},
            ExpressionAttributeValues: {
                ":type": 'B',
            },
            ScanIndexForward: false,
            Limit: 1
        }).promise()

        if (Items.length == 0) {
            return -1
        }

        return Items[0].index
    }


    async saveBlock(block) {
        console.log('Start Save Block')
        console.time('Save Block')
        try {
            block.hash = block.hash.toLowerCase()
            block.miner = block.miner.toLowerCase()
            block.transactionIds = block.transactions.map(t => t.id.toLowerCase())
            block.transactionCount = block.transactions.length
            block.updateTime = new Date().toISOString()
            block['type'] = 'B'

            await this.client.put({
                TableName: prefix("Block"),
                Item: {...block, transactions: []}
            }).promise()
        } catch(e) {
            console.error(block)
            console.error(e)
            throw e
        }
        console.timeEnd('Save Block')
    }

    async saveLatestBlock(_block) {
        let block = {..._block}
        delete block.transactions
        delete block.transactionIds
        await this.client.put({
            TableName: prefix("LatestBlocks"),
            Item: block
        }).promise()

        try {
            let {Items} = await this.client.query({
                TableName: prefix("LatestBlocks"),
                ProjectionExpression: "#index",
                KeyConditionExpression: "#type = :type AND #index < :index",
                ExpressionAttributeNames  : {"#type": "type", "#index": "index"},
                ExpressionAttributeValues: {
                    ":type": 'B',
                    ":index": block.index - 100
                },
                limit: 10
            }).promise()

            if (Items.length > 0) {
                await forEachSemaphore(Items, async (item) => {
                    console.log('DELETE LATEST BLOCK', item.index)
                    await this.client.delete({
                        TableName: prefix("LatestBlocks"),
                        Key: {
                            "type": "B",
                            "index": item.index
                        }
                    }).promise()
                }, 5)
            }
        } catch(e) {}
    }

    async saveTransactions(block, txs) {
        console.log('Start Save Transactions')
        console.time('Save Transactions')
        try {
            txs.forEach(tx => {
                tx.id = tx.id.toLowerCase()
                tx.signer = tx.signer.toLowerCase()
                tx.blockIndex = block.index
                tx.blockTimestamp = block.timestamp
                tx.updateTime = new Date().toISOString()
                tx.updatedAddresses = tx.updatedAddresses.map(addr => addr.toLowerCase())
            })

            await forEachSemaphore(txs,
                async (tx) => {
                    await this.client.put({TableName: prefix("Transaction"), Item: tx}).promise()
                }, 100)

        } catch(e) {
            console.log(e)
        }
        console.timeEnd('Save Transactions')
    }

    async saveAccountTransactions(block, txs) {
        console.log('Start Save AccountTransactions')
        console.time('Save AccountTransactions')
        let involvedTxs = _.flatten(txs.map(tx => {
            let items = tx.updatedAddresses.map(address => {
                return {
                    pk: address + '#' + tx.id,
                    address: address,
                    blockIndex: block.index,
                    txId: tx.id,
                    accountUpdated: true,
                    type: tx.signer == address ? 'SIGNED' : 'INVOLVED',
                    updateTime: new Date().toISOString()
                }
            })

            if (!tx.updatedAddresses.find(addr => addr == tx.signer)) {
                items.push({
                    pk: tx.signer + '#' + tx.id,
                    address: tx.signer,
                    blockIndex: block.index,
                    txId: tx.id,
                    type: 'SIGNED',
                    accountUpdated: false,
                    updateTime: new Date().toISOString()
                })
            }

            let actionTypes = tx.actions
                .filter(action => action['typeId'])
                .map(action => action['typeId'])

            if (actionTypes && actionTypes.length > 0) {
                let typedItems = _.flatten(actionTypes.map((actionType, actionIdx) => {
                    return items.map(item => {
                        let v = {...item, addressWithType: item.address + '#' + actionType, typeId: actionType}
                        if (actionIdx > 0) {
                            v['pk'] += '/' + actionIdx
                        }
                        return v
                    })
                }))
                return typedItems
            } else {
                return items
            }
        }))

        await forEachSemaphore(involvedTxs, async (tx) => {
            await this.client.put({
                TableName: prefix("AccountTransaction"),
                Item: tx
            }).promise()
        }, 50)

        console.timeEnd('Save AccountTransactions')
    }

    async saveActions(block, txs) {
        console.time('Save Action')
        let actions = _.flatten(txs.map(tx => {
            return tx.actions.map((action, idx) => {
                if (action['raw'] || action['inspection']) {
                    let inspection = parseAction(action)
                    inspection['txIdSeq'] = tx.id + '/' + idx
                    inspection['actionCount'] = tx.actions.length
                    inspection['blockIndex'] = block.index
                    inspection['typeId'] = inspection['type_id']
                    inspection['timestamp'] = tx.timestamp
                    delete inspection['type_id']
                    if (inspection['values']) {
                        for (let key of Object.keys(inspection['values'])) {
                            if (!inspection[key]) {
                                inspection[key] = inspection['values'][key]
                            } else {
                                inspection['_' + key] = inspection['values'][key]
                            }
                        }
                        delete inspection['values']
                    }

                    // avatarAddress 가 없고 alias가 있는경우
                    if (!inspection['avatarAddress']) {
                        if (inspection['a'] && typeof inspection['a'] == "string" && inspection['a'].startsWith('0x')) {
                            inspection['avatarAddress'] = inspection['a']
                        } else if (inspection['aa'] && typeof inspection['aa'] == "string" && inspection['aa'].startsWith('0x')) {
                            inspection['avatarAddress'] = inspection['aa']
                        } else if (inspection['sva'] && typeof inspection['sva'] == "string" && inspection['sva'].startsWith('0x')) {
                            inspection['avatarAddress'] = inspection['sva']
                        } else if (inspection['ba'] && typeof inspection['ba'] == "string" && inspection['ba'].startsWith('0x')) {
                            inspection['avatarAddress'] = inspection['ba']
                        } else if (inspection['sellerAvatarAddress'] && typeof inspection['sellerAvatarAddress'] == "string" && inspection['sellerAvatarAddress'].startsWith('0x')) {
                            inspection['avatarAddress'] = inspection['sellerAvatarAddress']
                        }
                    }

                    if (inspection['avatarAddress']) {
                        inspection['avatarAddress'] = inspection['avatarAddress'].toLowerCase()
                    }
                    return inspection
                }
            }).filter(a => a)
        }))

        console.log('save actions', actions.length)
        await forEachSemaphore(actions, async (action) => {
            try {
                await this.client.put({
                    TableName: prefix("Action"),
                    Item: action
                }).promise()
            } catch(e){
                console.log('save action failed', action)
                throw e
            }
        }, 50)
        console.timeEnd('Save Action')
    }

    async saveAccount(accounts) {
        console.time('Save Account')
        await forEachSemaphore(accounts, async (account) => {
            try {
                await this.client.put({
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
        console.timeEnd('Save Account')

    }

    async save(block) {
        if (block.transactions && block.transactions.length >= 0) {
            block.transactions.forEach(tx => {
                tx.actions
                    .filter(action => action.raw || action.inspection)
                    .forEach(action => {
                        let actionData = parseAction(action)
                        action['typeId'] = actionData['type_id']
                        //transfer_asset# 의 경우 recipient를 updatedAddress에 강제로 넣어줌.
                        try {
                            if (action['typeId'].startsWith('transfer') && actionData['values'] && actionData['values']['recipient']) {
                                tx.updatedAddresses = [...tx.updatedAddresses, actionData['values']['recipient']]

                            } else if (action['typeId'].startsWith('mint_assets') && actionData['values'] && actionData['values'].length >= 2) {
                                for (let i = 1; i < actionData['values'].length; i++) {
                                    const recipient = actionData['values'][i][0]
                                    tx.updatedAddresses = [...tx.updatedAddresses, recipient]
                                }
                            } else if (action['typeId'].startsWith('register_product') && actionData['values'] && actionData['values']['a']) {
                                const avatar = actionData['values']['a']
                                tx.updatedAddresses = [...tx.updatedAddresses, avatar]
                            } else if (action['typeId'].startsWith('buy_product') && actionData['values'] && actionData['values']['p']) {
                                const avatar = actionData['values']['a']

                                const sellers = actionData['values']['p'].map(p => p[2])
                                tx.updatedAddresses = [...tx.updatedAddresses, ...sellers, avatar]
                            }

                            tx.updatedAddresses = _.uniq(tx.updatedAddresses.map(v => v.toLowerCase()))
                        } catch(e) {
                            console.log(e)
                        }

                        //Dynamo 저장 한계 (400KB) 때문에 액션 밸류가 300KB가 넘으면 타입만 저장
                        if (JSON.stringify(action).length > 102400 * 3) {
                            delete action['raw']
                            action['inspection'] = JSON.stringify({
                                type_id: action['typeId'],
                                isHuge: true
                            })
                        }
                    })
            })

            await Promise.all([
                this.saveTransactions(block, block.transactions),
                this.saveAccountTransactions(block, block.transactions),
                this.saveActions(block, block.transactions)
            ])
            if (await this.checkTransactionsSaved(block)) {
                await this.saveBlock(block)
            } else {
                throw 'can not save block'
            }
        } else {
            await this.saveBlock(block)
        }

    }

    async checkTransactionsSaved(block) {
        console.time('Validate Transactions')
        try {
            let txCount = await this.getTotalCount({
                TableName: prefix("Transaction"),
                IndexName: "block-index",
                ProjectionExpression: 'id',
                KeyConditionExpression: "blockIndex = :blockIndex",
                ExpressionAttributeValues: {
                    ":blockIndex": block.index,
                }
            })

            if (block.transactions.length != txCount) {
                return false
            }
        } catch(e) {
            console.log('Validate Transaction Error', e)
            throw e
        } finally {
            console.timeEnd('Validate Transactions')
        }


        console.time('Validate AccountTransactions')
        let involvedCount = await this.getTotalCount({
            TableName: prefix("AccountTransaction"),
            IndexName: "block-index",
            ProjectionExpression: 'blockIndex',
            KeyConditionExpression: "blockIndex = :blockIndex",
            ExpressionAttributeValues: {
                ":blockIndex": block.index,
            }
        })

        let count = block.transactions.map(tx => {
            let items = tx.updatedAddresses.map(address => address.toLowerCase())
            if (items.indexOf(tx.signer.toLowerCase()) == -1) {
                items.push(tx.signer)
            }
            return items.length
        }).reduce((a, b) => a + b, 0)
        console.timeEnd('Validate AccountTransactions', involvedCount, count)

        if (involvedCount != count) {
            console.error(involvedCount, count)
            return false
        }


        console.time('Validate Action')
        let actionCount = await this.getTotalCount({
            TableName: prefix("Action"),
            IndexName: "block-index",
            ProjectionExpression: 'blockIndex',
            KeyConditionExpression: "blockIndex = :blockIndex",
            ExpressionAttributeValues: {
                ":blockIndex": block.index,
            }
        })

        let aCount = block.transactions.map(tx => {
            return tx.actions && tx.actions.length || 0
        }).reduce((a, b) => a + b, 0)
        console.timeEnd('Validate Action')

        if (actionCount != aCount) {
            return false
        }

        return true
    }
}


module.exports = new DynamoRepository()