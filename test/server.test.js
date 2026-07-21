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
