const axios = require("axios")

class NccDatasource {
  constructor() {
    this.endpoints = JSON.parse(process.env.graphqlEndpoints)
    this.dpEndpoint = process.env.dpEndpoint
  }
  async getAccountState(address, endpointIndex=0) {
    let endpoint = this.endpoints[endpointIndex]
    try {
      let {data} = await axios.create({timeout: 10000})({
        method: 'POST',
        url: endpoint,
        data: {
          "variables":{"address": address},
          "query":`
          query getAgent($address: Address!) {
            goldBalance(address: $address)
            stateQuery {
              agent(address: $address) {
                avatarStates {
                  actionPoint,
                  address,
                  blockIndex,
                  characterId,
                  dailyRewardReceivedIndex,
                  ear,
                  exp
                  hair
                  lens
                  level
                  name
                  tail
                  updatedAt
                  inventory {
                    equipments {
                      id
                      itemSubType
                      equipped
                    }
                  }
                }
              }
            }
          }
          `
        }
      })

      let goldBalance = data['data']['goldBalance']
      let agent = data['data']['stateQuery']['agent']
      let rows = []
      if (agent) {
        for (let avatar of agent['avatarStates']) {
          if (avatar && avatar.inventory && avatar.inventory.equipments && avatar.inventory.equipments.length > 0) {
            avatar.inventory.equipments = avatar.inventory.equipments.filter(({equipped}) => equipped)
          }
          rows.push({
            type: 'AVATAR',
            address: address.toLowerCase(),
            avatarAddress: avatar && avatar.address && avatar.address.toLowerCase(),
            avatarName: avatar && avatar.name && avatar.name.toLowerCase(),
            avatar,
            goldBalance,
          })
        }
      } else {
        //no avatar address
        rows.push({
          type: 'ACCOUNT',
          address: address.toLocaleLowerCase(),
          avatarAddress: 'NOAVATAR',
          goldBalance
        })
      }

      return rows
    } catch(e) {
    }
  }

  async getLatestEndpointIndex(lastBlockIndex = 0) {
    let response = {}
    for (let endpointIndex = 0; endpointIndex < this.endpoints.length; endpointIndex++) {
      try {
        let latestIndex = await this.getLatestBlockIndex(endpointIndex)
        if (latestIndex) {
          response = {latestIndex, endpointIndex}
          if (lastBlockIndex < latestIndex || (endpointIndex + 1) == this.endpoints.length) {
            return response
          }
        }
      } catch (e) {
        console.log(e)
      }
    }

    return response
  }
  async getLatestBlockIndex(endpointIndex = 0, timeout = 10000) {
    let endpoint = this.endpoints[endpointIndex]
    try {
      let {data} = await axios.create({timeout})({
        method: 'POST',
        url: endpoint,
        data: {
          "variables":{"offset": 0},
          "query":`
        query getBlock($offset: Int!) {
          chainQuery {
            blockQuery {
              blocks(offset: $offset, limit: 1, desc:true) {
                index
              }
            }
          }
        }
        `
        }
      })
      let latestIndex = data['data']['chainQuery']['blockQuery']['blocks'][0]['index']
      return latestIndex
    } catch (e) {
      console.log(e)
    }

    return null
  }

  async fetchBlock(index, endpointIndex = 0) {
    try {
      let endpoint = this.endpoints[endpointIndex]
      console.time('Fetch Block ' + index)
      let {data} = await axios({
        method: 'POST',
        url: endpoint,
        data: {
          "variables":{"index":index},
          "query":`
        query getBlock($index: ID!) {
          chainQuery {
            blockQuery {
              block(index:$index) {
                index
                hash
                miner
                stateRootHash
                timestamp
                transactions {
                  actions {
                    raw
                    inspection
                  }
                  id
                  nonce
                  publicKey
                  signature
                  signer
                  timestamp
                  updatedAddresses
                }
              }
            }
          }
        }
        `
        }
      })

      console.timeEnd('Fetch Block ' + index)
      return data['data']['chainQuery']['blockQuery']['block']
    } catch(e) {
      console.log(e)
    }
    return null
  }

  async getTxStatus(txId, endpointIndex = 0) {
    try {
      let endpoint = this.endpoints[endpointIndex]
      let {data} = await axios({
        method: 'POST',
        url: endpoint,
        data: {
          "variables":{"txId":txId},
          "query":`
            query query($txId: TxId!) {
              transaction {
                transactionResult(txId: $txId) {
                  txStatus
                }
              }
            }`
        }
      })
      return data['data']['transaction']['transactionResult']['txStatus']
    } catch(e) {
      console.log(e)
    }
    return null
  }

  async getBattleArenaInfo(index, endpointIndex = 1) {
    try {
      let {data} = await axios({
        method: 'POST',
        url: this.dpEndpoint,
        data: {
          variables:{ index },
          query: `query getBattleArenaInfo($index: Long!) {
            battleArenaInfo(index: $index) {
              championshipId
              round
              startBlockIndex
              endBlockIndex
              arenaType
            }
          }`,
        }
      });
      return data['data']['battleArenaInfo'];
    } catch(e) {
      console.log(e);
    }
  }
  async getArenaParticipants(championshipId, round, endpointIndex = 1) {
    try {
      let {data} = await axios({
        method: 'POST',
        url: this.dpEndpoint,
        data: {
          variables:{ championshipId, round },
          query: `query getBattleArenaInfo($championshipId: Int!, $round: Int!) {
            battleArenaRanking(championshipId: $championshipId, round: $round) {
              name
              ranking
              avatarAddress
              score
              avatarLevel
              cp
              winCount
              lossCount
              purchasedTicketCount
            }
          }`,
        },
      });
      return data['data']['battleArenaRanking'];
    } catch(e) {
      console.log(e)
    }
  }
  async getAvatarImages(avatarAddresses = [], endpointIndex = 0) {
    try {
      let endpoint = this.endpoints[endpointIndex]
      const innerQuery = avatarAddresses.map((avatarAddress, index) => {
        return `avatar${index}: avatar(avatarAddress: "${avatarAddress}") {
          inventory {
            equipments(equipped: true, itemSubType: ARMOR) {
              id
              itemType
              itemSubType
              equipped
            }
          }
        }`;
      }).join('\n');

      let {data} = await axios({
        method: 'POST',
        url: endpoint,
        data: {
          query: `query getAvatarImages {
            stateQuery { ${innerQuery} }
          }`,
        }
      });

      const avatars = data['data']['stateQuery'];
      return avatarAddresses.map((avatarAddress, index) => {
        const armorId = avatars[`avatar${index}`].inventory.equipments[0]?.id ?? '10200000';
        return {
          avatarAddress,
          imageUrl: `https://raw.githubusercontent.com/planetarium/NineChronicles/v200020-1/nekoyume/Assets/Resources/UI/Icons/Item/${armorId}.png`,
        };
      });
    } catch(e) {
      console.log(e)
    }
  }

  async getArenaParticipantsByAvatarAddress(avatarAddress = '0x0000000000000000000000000000000000000000', endpointIndex = 0) {
    try {
      let avatarAddress = '';
      let {data} = await axios({
        method: 'POST',
        url: this.dpEndpoint,
        data: {
          variables: { avatarAddress },
          query: `query getArena($avatarAddress: Address) {
            stateQuery {
              arenaParticipants(avatarAddress: $avatarAddress) {
                avatarAddr
                rank
                nameWithHash
                cp
                score
                winScore
                loseScore
              }
            }
          }`,
        }
      });

      return data['data']['stateQuery']['arenaParticipants'];
    } catch(e) {
      console.log(e)
    }
  }
}

module.exports = new NccDatasource()