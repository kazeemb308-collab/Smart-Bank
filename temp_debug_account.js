const http = require('http');
const querystring = require('querystring');
const postData = querystring.stringify({ email: 'admin@smartbank.com', password: 'Admin@1234' });
const options = {
  hostname: '127.0.0.1',
  port: 4000,
  path: '/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  console.log('login status', res.statusCode);
  const cookies = res.headers['set-cookie'] ? res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ') : '';
  console.log('cookies', cookies);
  const req2 = http.request({ hostname: '127.0.0.1', port: 4000, path: '/account', method: 'GET', headers: { Cookie: cookies } }, (res2) => {
    console.log('/account status', res2.statusCode);
    let body = '';
    res2.on('data', (chunk) => { body += chunk; });
    res2.on('end', () => { console.log('account len', body.length); console.log(body.slice(0, 200)); });
  });
  req2.on('error', (e) => console.error('req2 err', e.message));
  req2.end();
});
req.on('error', (e) => console.error('login err', e.message));
req.write(postData);
req.end();
