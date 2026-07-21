const http = require('http');
const url = 'http://127.0.0.1:3000/';
http.get(url, (res) => {
  console.log('STATUS:', res.statusCode);
  console.log('HEADERS:', res.headers);
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('BODY START:\n', body.slice(0, 300));
  });
}).on('error', (e) => {
  console.error('ERROR:', e.message);
});
