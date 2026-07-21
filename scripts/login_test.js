const http = require('http');
const querystring = require('querystring');
const postData = querystring.stringify({ email: 'admin@smartbank.com', password: 'Admin@1234' });

const options = {
  hostname: '127.0.0.1',
  port: 3000,
  path: '/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  console.log('STATUS:', res.statusCode);
  console.log('HEADERS:', res.headers);
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('BODY START:\n', body.slice(0, 2000));
  });
});

req.on('error', (e) => console.error('problem with request:', e));
req.write(postData);
req.end();
