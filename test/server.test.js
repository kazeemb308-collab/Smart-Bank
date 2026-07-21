const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

test('server boots and renders the login page', async () => {
  const server = app.listen(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Smart Bank/);
  server.close();
});

test('authenticated users can reach the account page', async () => {
  const server = app.listen(0);
  const { port } = server.address();

  const loginResponse = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=admin@smartbank.com&password=Admin@1234'
  });

  const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'expected a session cookie after login');

  const accountResponse = await fetch(`http://127.0.0.1:${port}/account`, {
    headers: { Cookie: cookie }
  });

  assert.equal(accountResponse.status, 200);
  const html = await accountResponse.text();
  assert.match(html, /Account & Support/);
  server.close();
});
