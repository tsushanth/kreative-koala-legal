import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleUnsubscribe, sign, verify, b64urlEncode, b64urlDecode, resetRateLimit, ADDRESS_LINES } from '../src/unsubscribe.mjs';
import worker from '../worker.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const SECRET = V.secret;
const ENV = { UNSUB_SECRET: SECRET, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'sb_secret_dummy' };
const FIXED = () => new Date('2026-11-13T12:00:00Z');
const enc = (s) => b64urlEncode(new TextEncoder().encode(s));

function fakeFetch(status = 201) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status }); };
  f.calls = calls;
  return f;
}
const link = (e, l, s) => `https://kreativekoala.llc/unsubscribe?e=${e}&l=${l}&s=${s}`;
const good = V.vectors[0];
const goodUrl = link(good.e, good.list, good.s);
const run = (req, env = ENV, f = fakeFetch()) => handleUnsubscribe(req, env, { fetchImpl: f, now: FIXED, log: () => {} });

beforeEach(() => resetRateLimit());

test('golden vectors: sign() reproduces every shared vector', async () => {
  for (const v of V.vectors) {
    assert.equal(enc(v.normalized), v.e);
    assert.equal(await sign(SECRET, v.list, v.normalized), v.s, v.normalized);
    assert.equal(await verify(SECRET, v.list, v.normalized, v.s), true);
  }
  assert.ok(V.vectors.some((v) => v.s.includes('-')) && V.vectors.some((v) => v.s.includes('_')), 'vectors cover - and _');
});

test('verify rejects wrong list, wrong email, wrong secret, malformed and non-canonical signatures', async () => {
  assert.equal(await verify(SECRET, 'sa', good.normalized, good.s), false);
  assert.equal(await verify(SECRET, good.list, 'mallory@example.com', good.s), false);
  assert.equal(await verify('another-secret-0123456789', good.list, good.normalized, good.s), false);
  assert.equal(await verify(SECRET, good.list, good.normalized, good.s.slice(0, -1)), false);
  assert.equal(await verify(SECRET, good.list, good.normalized, good.s + 'A'), false);
  assert.equal(await verify(SECRET, good.list, good.normalized, ''), false);
  assert.equal(await verify(SECRET, good.list, good.normalized, null), false);
  assert.equal(b64urlDecode('abc='), null); // padding is not allowed
});

test('GET renders the confirmation page and does NOT touch the database', async () => {
  const f = fakeFetch();
  const res = await run(new Request(goodUrl), ENV, f);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<form method="post"/);
  assert.match(body, /Unsubscribe from MeetingMind announcements/);
  assert.ok(body.includes(ADDRESS_LINES));
  assert.ok(!body.includes(good.normalized), 'full email is not shown');
  assert.equal(f.calls.length, 0);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(res.headers.get('X-Robots-Tag'), /noindex/);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
});

test('HEAD does not touch the database either', async () => {
  const f = fakeFetch();
  const res = await run(new Request(goodUrl, { method: 'HEAD' }), ENV, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

test('POST with a valid signature inserts exactly once, with reason and notes', async () => {
  const f = fakeFetch();
  const res = await run(new Request(goodUrl, { method: 'POST' }), ENV, f);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You will not receive further announcement emails from MeetingMind/);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://example.supabase.co/rest/v1/outreach_suppressions');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
  assert.equal(c.init.headers.apikey, 'sb_secret_dummy');
  assert.equal(c.init.headers.Authorization, undefined, 'sb_secret_ keys are not sent as a Bearer token');
  assert.deepEqual(JSON.parse(c.init.body), [{ email: 'alice@example.com', reason: 'unsubscribed', notes: 'one-click link mm 2026-11-13' }]);
});

test('legacy JWT service keys are also sent as Authorization', async () => {
  const f = fakeFetch();
  await run(new Request(goodUrl, { method: 'POST' }), { ...ENV, SUPABASE_SERVICE_KEY: 'eyJhbGciOi.fake.jwt' }, f);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer eyJhbGciOi.fake.jwt');
});

test('RFC 8058 one-click POST (List-Unsubscribe=One-Click body) works', async () => {
  const f = fakeFetch();
  const res = await run(new Request(goodUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }), ENV, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
});

test('form POST from the confirmation page works end to end', async () => {
  const f = fakeFetch();
  const page = await (await run(new Request(goodUrl), ENV, f)).text();
  const action = page.match(/<form method="post" action="([^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.equal(new URL(action, 'https://kreativekoala.llc').search, new URL(goodUrl).search);
  const res = await run(new Request(new URL(action, 'https://kreativekoala.llc'), { method: 'POST', body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }) }), ENV, f);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
});

test('duplicate email is idempotent: ignore-duplicates answer (201/200/204) is success, repeated clicks succeed', async () => {
  for (const status of [200, 201, 204]) {
    const res = await run(new Request(goodUrl, { method: 'POST' }), ENV, fakeFetch(status));
    assert.equal(res.status, 200, String(status));
  }
  const f = fakeFetch();
  assert.equal((await run(new Request(goodUrl, { method: 'POST' }), ENV, f)).status, 200);
  assert.equal((await run(new Request(goodUrl, { method: 'POST' }), ENV, f)).status, 200);
});

test('POST with an invalid signature is a generic 400 and makes no DB call', async () => {
  const f = fakeFetch();
  const bad = good.s.slice(0, -2) + (good.s.endsWith('AA') ? 'BB' : 'AA');
  const res = await run(new Request(link(good.e, good.list, bad), { method: 'POST' }), ENV, f);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /This link is not valid/);
  assert.ok(!body.includes('signature') && !body.includes(good.normalized));
  assert.equal(f.calls.length, 0);
});

test('missing, tampered email, tampered list, unknown list and garbage params are all the same 400', async () => {
  const f = fakeFetch();
  const urls = [
    'https://kreativekoala.llc/unsubscribe',
    `https://kreativekoala.llc/unsubscribe?e=${good.e}&l=${good.list}`,
    link(enc('mallory@example.com'), good.list, good.s),
    link(good.e, 'sa', good.s),
    link(good.e, 'zz', good.s),
    link(good.e, '__proto__', good.s),
    link('!!!', good.list, good.s),
    link(enc('not-an-email'), good.list, good.s),
    link(enc('a@b.co\nbcc@evil.com'), good.list, good.s),
  ];
  const bodies = new Set();
  for (const u of urls) {
    for (const method of ['GET', 'POST']) {
      resetRateLimit();
      const res = await run(new Request(u, { method }), ENV, f);
      assert.equal(res.status, 400, `${method} ${u}`);
      bodies.add(await res.text());
    }
  }
  assert.equal(bodies.size, 1, 'identical page for every failure: no enumeration');
  assert.equal(f.calls.length, 0);
});

test('lowercase normalization: mixed-case e= with a signature over the lowercase address is accepted and stored lowercase', async () => {
  const f = fakeFetch();
  const v = V.vectors.find((x) => x.email !== x.normalized && x.email.startsWith('Dana'));
  const res = await run(new Request(link(enc(v.email), v.list, v.s), { method: 'POST' }), ENV, f);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(f.calls[0].init.body)[0].email, v.normalized);
});

test('unicode address vector round-trips', async () => {
  const f = fakeFetch();
  const v = V.vectors.find((x) => /[^\x00-\x7f]/.test(x.normalized));
  assert.equal((await run(new Request(link(v.e, v.list, v.s), { method: 'POST' }), ENV, f)).status, 200);
  assert.equal(JSON.parse(f.calls[0].init.body)[0].email, v.normalized);
});

test('all three list ids work and name their app', async () => {
  for (const [l, app] of [['mm', 'MeetingMind'], ['sa', 'ScribeAI'], ['rv', 'RiddleVerse']]) {
    const e = 'list.check@example.com';
    const s = await sign(SECRET, l, e);
    const res = await run(new Request(link(enc(e), l, s)));
    assert.match(await res.text(), new RegExp(`from ${app} announcements`));
  }
});

test('backend failure on POST is a 503 (so Gmail retries / the user is told) and is not reported as success', async () => {
  const res = await run(new Request(goodUrl, { method: 'POST' }), ENV, fakeFetch(500));
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /You are unsubscribed/);
});

test('missing or short UNSUB_SECRET fails closed; missing Supabase secrets give 503 without a fetch', async () => {
  const f = fakeFetch();
  assert.equal((await run(new Request(goodUrl, { method: 'POST' }), { ...ENV, UNSUB_SECRET: undefined }, f)).status, 503);
  assert.equal((await run(new Request(goodUrl, { method: 'POST' }), { ...ENV, UNSUB_SECRET: 'short' }, f)).status, 503);
  assert.equal((await run(new Request(goodUrl, { method: 'POST' }), { UNSUB_SECRET: SECRET }, f)).status, 503);
  assert.equal(f.calls.length, 0);
});

test('other methods are 405', async () => {
  const res = await run(new Request(goodUrl, { method: 'PUT' }));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET, HEAD, POST');
});

test('rate limit: repeated bad signatures from one IP are throttled, other IPs and good links are unaffected', async () => {
  const badUrl = link(good.e, good.list, 'A'.repeat(43));
  const hdr = (ip) => ({ headers: { 'CF-Connecting-IP': ip } });
  let last;
  for (let i = 0; i < 11; i++) last = await run(new Request(badUrl, hdr('203.0.113.9')));
  assert.equal(last.status, 429);
  assert.equal((await run(new Request(goodUrl, hdr('203.0.113.9')))).status, 429);
  assert.equal((await run(new Request(goodUrl, hdr('198.51.100.1')))).status, 200);
});

test('logs never contain the full email', async () => {
  const lines = [];
  await handleUnsubscribe(new Request(goodUrl, { method: 'POST' }), ENV, { fetchImpl: fakeFetch(), now: FIXED, log: (l) => lines.push(l) });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(!l.includes('alice') && !l.includes('example.com'));
  assert.match(lines.at(-1), /"h":"[0-9a-f]{8}"/);
});

test('pages are ASCII only (no em dashes or smart quotes)', async () => {
  const pages = [await run(new Request(goodUrl)), await run(new Request(goodUrl, { method: 'POST' })), await run(new Request('https://kreativekoala.llc/unsubscribe'))];
  for (const r of pages) assert.doesNotMatch(await r.text(), /[^\x00-\x7f]/);
});

// ---- worker.js integration: the route is wired and everything else is untouched ----
function assetsEnv(extra = {}) {
  const seen = [];
  return {
    ...extra,
    seen,
    ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('<html>static</html>', { status: 200, headers: { 'Content-Type': 'text/html', 'X-Asset': '1' } }); } },
  };
}

test('worker: /unsubscribe is handled by the route, not by ASSETS', async () => {
  const env = assetsEnv(ENV);
  const res = await worker.fetch(new Request(goodUrl), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Unsubscribe from MeetingMind/);
  assert.deepEqual(env.seen, []);
  const res2 = await worker.fetch(new Request('https://kreativekoala.llc/unsubscribe/'), env);
  assert.equal(res2.status, 400);
  assert.deepEqual(env.seen, []);
});

test('worker: other paths still go to ASSETS with the same security headers as before', async () => {
  for (const p of ['/', '/privacy.html', '/terms.html', '/unsubscribe.html', '/unsubscribed', '/voxkey-chrome/privacy.html']) {
    const env = assetsEnv(ENV);
    const res = await worker.fetch(new Request(`https://kreativekoala.llc${p}`), env);
    assert.deepEqual(env.seen, [p], p);
    assert.equal(res.headers.get('X-Asset'), '1');
    assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=31536000');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/);
  }
});

test('worker: http redirects to https and /account-deletion alias is preserved', async () => {
  const env = assetsEnv(ENV);
  const r1 = await worker.fetch(new Request('http://kreativekoala.llc/unsubscribe?e=x'), env);
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get('Location'), 'https://kreativekoala.llc/unsubscribe?e=x');
  const r2 = await worker.fetch(new Request('https://kreativekoala.llc/account-deletion'), env);
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.get('Location'), 'https://kreativekoala.llc/delete-account');
});
