import test from "node:test";
import assert from "node:assert/strict";

import { server } from "../scripts/serve.mjs";

let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("a malformed encoded path fails closed without terminating the server", async () => {
  const malformed = await fetch(`${baseUrl}/%`);
  assert.equal(malformed.status, 400);
  assert.equal(await malformed.text(), "Bad request");

  const healthy = await fetch(`${baseUrl}/`, { method: "HEAD" });
  assert.equal(healthy.status, 200);
});

test("unsupported methods and traversal attempts fail closed with security headers", async () => {
  const unsupported = await fetch(`${baseUrl}/`, { method: "POST" });
  assert.equal(unsupported.status, 405);

  const traversal = await fetch(`${baseUrl}/..%2Fpackage.json`);
  assert.equal(traversal.status, 400);
  assert.equal(traversal.headers.get("permissions-policy"), "tools=(self)");
  assert.match(traversal.headers.get("content-security-policy"), /default-src 'self'/);
});
