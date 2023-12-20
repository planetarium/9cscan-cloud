require('./setenv')()
const syncBlock = require('./app')

async function run() {
  for (let block = 317782; block > 1; block--) {
    await syncBlock(block)
    console.log(block)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

run()
