const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

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

test('customer support messages appear in the admin conversation view', async () => {
  const server = app.listen(0);
  const { port } = server.address();

  const registerResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'full_name=Support%20User&email=support-test@example.com&phone=5551234567&password=Password123!&confirm_password=Password123!'
  });

  const customerCookie = registerResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(customerCookie, 'expected a session cookie after registration');

  const messageResponse = await fetch(`http://127.0.0.1:${port}/account/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: customerCookie
    },
    body: 'message=Please%20review%20my%20account'
  });

  assert.equal(messageResponse.status, 200);

  const adminLoginResponse = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=admin@smartbank.com&password=Admin@1234'
  });

  const adminCookie = adminLoginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(adminCookie, 'expected a session cookie for the admin login');

  const adminResponse = await fetch(`http://127.0.0.1:${port}/admin`, {
    headers: { Cookie: adminCookie }
  });

  const html = await adminResponse.text();
  assert.match(html, /Please review my account/);
  server.close();
});
