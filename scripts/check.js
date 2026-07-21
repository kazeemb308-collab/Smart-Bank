const http = require('http');
http.get('http://127.0.0.1:3000/', (res) => {
  console.log('STATUS:' + res.statusCode);
  res.resume();
  res.on('end', () => process.exit(0));
}).on('error', (e) => {
  console.error('ERR:' + e.message);
  process.exit(2);
});
