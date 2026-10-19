import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const source = await readFile(new URL('../../frontend/public/_worker.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const secret = randomBytes(48).toString('hex');
const env = { DARVEN_ORIGIN_SECRET: secret, ASSETS: { fetch: async () => { throw new Error('unexpected asset request'); } } };
const originalFetch = globalThis.fetch;
process.on('exit', () => { globalThis.fetch = originalFetch; });

test('all API prefixes and health route to recovered origin with exact path/query', async () => {
  const paths = ['/health', '/api/status', '/api/tables', '/api/events', '/api/login', '/api/admin/users', '/api/predictions/ui-history', '/api/arbitrary/future-route'];
  for (const path of paths) {
    let target;
    const response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (url) => { target = String(url); return response; };
    assert.equal(await worker.fetch(new Request(`https://darven-ai-baccarat.pages.dev${path}?x=a%2Fb&n=1&n=2`), env), response);
    assert.equal(target, `http://35.189.177.125.sslip.io${path}?x=a%2Fb&n=1&n=2`);
  }
});

test('server guard overwrites client value, preserves authorization, strips spoofable forwarding headers', async () => {
  let init;
  globalThis.fetch = async (_, options) => { init = options; return new Response('ok'); };
  await worker.fetch(new Request('https://example.test/api/status', { headers: { 'X-Darven-Edge-Secret': 'untrusted-client', 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2', authorization: 'Bearer nonsecret-test-fixture', cookie: 'fixture=value', 'Last-Event-ID': 'event-42' } }), env);
  assert.ok(init.headers.get('X-Darven-Edge-Secret') === secret, 'runtime guard binding must be preserved');
  assert.equal(init.headers.get('cf-connecting-ip'), null);
  assert.equal(init.headers.get('x-forwarded-for'), null);
  assert.equal(init.headers.get('authorization'), 'Bearer nonsecret-test-fixture');
  assert.equal(init.headers.get('cookie'), 'fixture=value');
  assert.equal(init.headers.get('Last-Event-ID'), 'event-42');
});

test('GET HEAD POST PUT PATCH DELETE OPTIONS preserve methods body and manual redirects', async () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const request = new Request('https://example.test/api/action', { method, ...(method === 'GET' || method === 'HEAD' ? {} : { body: 'fixture-body' }) });
    let init;
    globalThis.fetch = async (_, options) => { init = options; return new Response(null, { status: 307, headers: { location: '/next' } }); };
    const response = await worker.fetch(request, env);
    assert.equal(init.method, method);
    assert.equal(init.body, method === 'GET' || method === 'HEAD' ? undefined : request.body);
    assert.equal(init.redirect, 'manual');
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), '/next');
  }
});

test('SSE passes exact unconsumed response and stream without buffering', async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const upstream = new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  globalThis.fetch = async () => upstream;
  const result = await worker.fetch(new Request('https://example.test/api/events'), env);
  assert.equal(result, upstream);
  assert.equal(result.body, stream);
  assert.equal(result.bodyUsed, false);
  const reader = result.body.getReader();
  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.enqueue(new TextEncoder().encode('data: second\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: second\n\n');
  controller.close();
  assert.equal((await reader.read()).done, true);
});

test('static routes remain exact ASSETS passthrough', async () => {
  for (const path of ['/', '/login', '/admin-login', '/assets/app.js', '/api', '/healthcheck']) {
    const req = new Request(`https://example.test${path}`);
    const asset = new Response('asset');
    globalThis.fetch = async () => { throw new Error('unexpected origin request'); };
    const result = await worker.fetch(req, { ...env, ASSETS: { fetch: async (incoming) => { assert.equal(incoming, req); return asset; } } });
    assert.equal(result, asset);
  }
});

test('origin errors propagate and upstream 522 is not disguised', async () => {
  const error = new Error('fixture upstream failure');
  globalThis.fetch = async () => { throw error; };
  await assert.rejects(worker.fetch(new Request('https://example.test/api/status'), env), (e) => e === error);
  const response = new Response('upstream unavailable', { status: 522 });
  globalThis.fetch = async () => response;
  assert.equal(await worker.fetch(new Request('https://example.test/health'), env), response);
});
