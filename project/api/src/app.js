const express = require('express');
const app = express();
const ncc = require('./datasource/ncc');
const dynamo = require('./repository/dynamo');
const cors = require('cors');
const axios = require('axios');
const _ = require('underscore');

app.use(cors())
app.get('/blocks', async function(req, res) {
  res.send(await dynamo.getBlocks(req.query || {}));
});

app.get('/blocks/:hashOrIndex', async function(req, res) {
  if (req.params.hashOrIndex.length == 64) {
    res.send(await dynamo.getBlockByHash(req.params.hashOrIndex.toLowerCase()));
  } else {
    res.send(await dynamo.getBlockByIndexWithTxs(req.params.hashOrIndex));
  }
});

app.get('/arena', async (req, res) => {
  const cacheKey = 'LastBlockIndex'
  const cached = await dynamo.getCache(cacheKey)
  if (cached) return res.json(cached);

  const lastBlockIndex = await ncc.getLatestBlockIndex();

  let arenaList = [];
  let currentBlockIndex = 1;
  while (currentBlockIndex <= lastBlockIndex) {
    const result = await ncc.getBattleArenaInfo(currentBlockIndex);
    arenaList = [...arenaList, result];
    currentBlockIndex = result.endBlockIndex + 1;
  }

  await dynamo.setCache(cacheKey, arenaList);

  res.json(arenaList);
});

app.get('/arena/:championshipId/:round', async (req, res) => {
  const {championshipId, round} = req.params;
  const cacheKey = `ArenaParticipants_${championshipId}_${round}`;

  let arenaParticipants = await dynamo.getCache(cacheKey)
  if (!arenaParticipants) {
    arenaParticipants = await ncc.getArenaParticipants(parseInt(championshipId, 10), parseInt(round, 10));
    await dynamo.setCache(cacheKey, arenaParticipants);
  }

  let {page, limit} = req.query;
  page = parseInt(page, 10) || 1;
  limit = parseInt(limit, 10) || 10;
  arenaParticipants = arenaParticipants.slice((page - 1) * limit, page * limit);

  const avatarAddresses = arenaParticipants.map((participant) => participant.avatarAddress);
  const imageUrls = await ncc.getAvatarImages(avatarAddresses);
  arenaParticipants = arenaParticipants.map((participant, index) => {
    participant.imageUrl = imageUrls[index].imageUrl;
    return participant;
  });

  res.json(arenaParticipants);
});

app.get('/status', async function(req, res) {
  let nodes = []
  let promises = []
  let syncedIndex = await dynamo.getLatestBlockIndex()
  let latestIndex = 0
  let nodeGap = 1000

  try {
    for (let i = 0; i < ncc.endpoints.length; i++) {
      promises.push(new Promise(async (resolve, reject) => {
        let endpoint = ncc.endpoints[i]
        try {
          let blockIndex = await ncc.getLatestBlockIndex(i, 10000)
          nodes.push({endpoint, blockIndex})
        } catch(e) {
          nodes.push({endpoint, blockIndex: null})
        }
        resolve()
      }))
    }
    await Promise.all(promises)
    latestIndex = _.max([0, ...nodes.map(n => n.blockIndex)])
    nodeGap = latestIndex - _.min(nodes.filter(n => n.endpoint.indexOf('9cscan') >= 0).map(n => n.blockIndex || 0))
  } catch(e) {

  }

  res.send({
    syncedIndex,
    latestIndex,
    nodeGap,
    syncGap: latestIndex - syncedIndex,
    nodes
  })
})

app.post('/account/refresh', async function(req, res) {
  if (req.query.address) {
    let {latestIndex, endpointIndex} = await ncc.getLatestEndpointIndex(await dynamo.getLatestBlockIndex() - 5)
    let accounts = await ncc.getAccountState(req.query.address, endpointIndex)
    if (accounts) {
      accounts.forEach(account => account.refreshBlockIndex = latestIndex)
      await dynamo.saveAccount(accounts)
    }
    res.send(await dynamo.getAccountStates(req.query.address))
  }
});

app.get('/transactions/:id/status', async function(req, res) {
  let tx = await dynamo.getTransactionById(req.params.id)
  if (tx) {
    if (tx.status != 'SUCCESS' || tx.status != 'FAILURE') {
      let {endpointIndex} = await ncc.getLatestEndpointIndex(tx.blockIndex)
      let status = await ncc.getTxStatus(tx.id, endpointIndex)
      if (status && tx.status != status) {
        tx.status = status
        await dynamo.saveTransaction(tx)
      }
    }

    res.send({status: tx.status})
  } else {
    res.send({status: 'INVALID'})
  }
});

app.get('/transactions', async function(req, res) {
  if (req.query && req.query.action) {
    res.send(await dynamo.getTransactionsByActionType(req.query))
  } else {
    res.send(await dynamo.getTransactions(req.query || {}))
  }
});

app.get('/transactions/:id', async function(req, res) {
  res.send(await dynamo.getTransactionById(req.params.id));
});

app.get('/account', async function(req, res) {
  if (req.query.address) {
    res.send(await dynamo.getAccountStates(req.query.address.toLowerCase()))
  } else if (req.query.avatar) {
    res.send(await dynamo.getAccountStatesByAvatar(req.query.avatar.toLowerCase()))
  }
});

app.get('/avatars', async function(req, res) {
  if (req.query.name && req.query.name.length >= 2) {
    res.send(await dynamo.searchAvatarsByName(req.query.name.toLowerCase()))
  } else {
    res.send([])
  }
});

app.get('/blocks/:index/transactions', async function(req, res) {
  res.send(await dynamo.getTransactionsByBlock(req.params.index));
});

app.get('/accounts/:account/transactions', async function(req, res) {
  res.send(await dynamo.getInvolvedTransactions({account:req.params.account.toLowerCase(), ...req.query}));
});

//count up to 1000
app.get('/accounts/:account/transactions/count', async function(req, res) {
  const {Count} = await dynamo.countAccountTransactions(req.params.account.toLowerCase());
  res.send({count: Count})
});

const CMC_KEYS = JSON.parse(process.env.CMC_KEYS || '{}')
app.get('/price', async function(req, res) {
  let apiKeys = Object.values(CMC_KEYS)
  
  let cacheKey = 'WNCG_PRICE'
  let cached = await dynamo.getCache(cacheKey)
  if (!cached || +new Date(cached.timestamp) + (1000 * 90) < +new Date ) {
    try {
      let {data} = await axios({
        method: 'GET',
        url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=wncg&aux=max_supply,circulating_supply,total_supply&skip_invalid=true&convert=USD', 
        headers: {'X-CMC_PRO_API_KEY': _.sample(apiKeys) || 'NO'},
        contentType: 'application/json'
      })
      
      if (data.data.WNCG.quote) {
        cached = data.data.WNCG
        cached.timestamp = +new Date
      }
      await dynamo.setCache(cacheKey, cached)
    } catch(e) {
    }
  }

  res.send(cached); 
});

module.exports = app
