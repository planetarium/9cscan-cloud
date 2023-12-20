const syncBlock = require('./app')

exports.get = async function(event, context, callback) {
  if (event.Records) {
    event.Records.forEach(async (record) => {
      if (record.eventName === 'INSERT') {
        const block = record.dynamodb.NewImage
        console.log(`SYNC BLOCK ${block.index['N']}`)
        await syncBlock(block.index['N'])
      }
    });
  }
  
  callback(null, {
    statusCode: 200,
    body: '{"result":"ok"}',
    headers: {'content-type': 'application/json'}
  })
}