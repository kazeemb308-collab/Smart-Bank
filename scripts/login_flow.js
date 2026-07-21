const http = require('http');
const querystring = require('querystring');

function postLogin(email, password) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({ email, password });
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
      const cookies = res.headers['set-cookie'];
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, cookies, body }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getDashboard(cookie) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: '/dashboard',
      method: 'GET',
      headers: {
        'Cookie': cookie || ''
      }
    };
    http.get(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

(async () => {
  try {
    const login = await postLogin('admin@smartbank.com', 'Admin@1234');
    console.log('Login status', login.status);
    console.log('set-cookie', login.cookies);
    const cookie = login.cookies ? login.cookies.map(c => c.split(';')[0]).join('; ') : '';
    const dash = await getDashboard(cookie);
    console.log('Dashboard status', dash.status);
    console.log('Dashboard snippet:\n', dash.body.slice(0,500));
  } catch (e) {
    console.error(e);
  }
})();
