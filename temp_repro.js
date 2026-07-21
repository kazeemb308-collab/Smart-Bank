const http = require('http');
const querystring = require('querystring');
const app = require('./server');
const server = app.listen(0, () => {
  const { port } = server.address();
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = querystring.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  (async () => {
    const registerRes = await post('/register', {
      full_name: 'Repro User',
      email: 'repro@example.com',
      phone: '5555555555',
      password: 'Password123!',
      confirm_password: 'Password123!'
    });
    console.log('register status', registerRes.status, 'location', registerRes.headers.location);
    const cookies = (registerRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const msgRes = await post('/account/message', { message: 'hello from repro user' }, { Cookie: cookies });
    console.log('message status', msgRes.status, 'location', msgRes.headers.location);
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
    console.log('latest messages:', data.messages.slice(-3));
    server.close();
  })().catch(err => {
    console.error(err);
    server.close();
  });
});
