// /unsubscribe: signed, one-click unsubscribe for announcement emails.
//
// Link:  /unsubscribe?e=<base64url(email lowercased)>&l=<list id>&s=<base64url(HMAC-SHA256(UNSUB_SECRET, list + "|" + email))>
//   GET   renders a confirmation page. It NEVER writes (mail scanners and Apple Mail privacy prefetch GET links).
//   POST  (form button, or RFC 8058 one-click "List-Unsubscribe=One-Click") verifies the signature and records the
//         suppression. The signature is the only credential; the request body is not read.
//
// Secrets (Worker secrets): UNSUB_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY. See docs/unsubscribe/README.md.
// Pure Web APIs only (Web Crypto, fetch, URL): no dependencies.

export const TABLE = 'outreach_suppressions';
export const MIN_SECRET_LENGTH = 16;
export const ADDRESS_LINES = 'Kreative Koala Solutions LLC, 5900 Balcones Dr, Ste 100, Austin TX 78731';

// ---- Lists and backends (add new entries here; see README "Adding a list") -------------------------------------
// A backend knows how to record a suppression. v1 has one: the SummaryAI Supabase project.
export const BACKENDS = {
  summaryai: {
    async suppress(email, note, env, fetchImpl) {
      const key = env.SUPABASE_SERVICE_KEY;
      const headers = {
        apikey: key,
        'Content-Type': 'application/json',
        // atomic "INSERT ... ON CONFLICT DO NOTHING" (no on_conflict column, so ANY unique constraint arbitrates):
        // a duplicate is success, races are harmless
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      };
      // Legacy service_role keys are JWTs and may also go in Authorization; new sb_secret_ keys must only use apikey.
      if (String(key).startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
      const res = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/${TABLE}`, {
        method: 'POST',
        headers,
        body: JSON.stringify([{ email, reason: 'unsubscribed', notes: note }]),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`backend status ${res.status}`);
    },
    configured: (env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY),
  },
};

export const LISTS = {
  mm: { app: 'MeetingMind', backend: 'summaryai' },
  sa: { app: 'ScribeAI', backend: 'summaryai' },
  rv: { app: 'RiddleVerse', backend: 'summaryai' },
  vb: { app: 'VibeBuild', backend: 'summaryai' },
};

// ---- Encoding and signing ---------------------------------------------------------------------------------------
const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Strict: only the base64url alphabet, canonical (re-encodes to the same string). Returns Uint8Array or null.
export function b64urlDecode(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 400 || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
  if (str.length % 4 === 1) return null;
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return b64urlEncode(out) === str ? out : null;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/;

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

const hmacKey = (secret, usage) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function sign(secret, list, email) {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`${list}|${email}`));
  return b64urlEncode(new Uint8Array(mac));
}

// Constant-time (WebCrypto HMAC verify). `s` must be the canonical 43-char base64url of a 32-byte MAC.
export async function verify(secret, list, email, s) {
  const sig = b64urlDecode(s);
  if (!sig || sig.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, enc.encode(`${list}|${email}`));
}

async function logTag(email) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(email)));
  return Array.from(d.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Rate limiting (per isolate, in memory, deliberately light) --------------------------------------------------
// Failed signatures are limited tightly (brute force); total requests loosely, because Gmail/Apple one-click POSTs can
// share source IPs.
const WINDOW_MS = 60_000;
const MAX_FAILS = 10;
const MAX_TOTAL = 120;
const MAX_TRACKED = 5000;
const buckets = new Map();

export function resetRateLimit() { buckets.clear(); }

function bucketFor(ip, now) {
  let b = buckets.get(ip);
  if (!b || now - b.start >= WINDOW_MS) {
    if (buckets.size >= MAX_TRACKED) buckets.clear();
    b = { start: now, total: 0, fails: 0 };
    buckets.set(ip, b);
  }
  return b;
}

// ---- Pages ----------------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
:root{--primary:#6366f1;--primary-dark:#4f46e5;--secondary:#1e293b;--text:#334155;--text-light:#64748b;--bg:#fff;--bg-alt:#f8fafc;--border:#e2e8f0}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:var(--text);background:var(--bg-alt);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
.brand{display:flex;align-items:center;gap:10px;color:var(--secondary);font-weight:700;text-decoration:none;margin-bottom:24px}
.brand img{width:36px;height:36px}
main{width:100%;max-width:520px;background:var(--bg);border:1px solid var(--border);border-radius:1rem;padding:28px 24px;box-shadow:0 4px 6px -1px rgb(0 0 0 / .1)}
h1{font-size:1.5rem;line-height:1.3;color:var(--secondary);margin-bottom:12px}
p{margin-bottom:14px}
.muted{color:var(--text-light);font-size:.9rem}
button{font:inherit;font-weight:600;color:#fff;background:var(--primary);border:0;border-radius:.5rem;padding:12px 22px;cursor:pointer;min-height:44px}
button:hover,button:focus{background:var(--primary-dark)}
button:focus-visible,a:focus-visible{outline:3px solid var(--primary-dark);outline-offset:2px}
a{color:var(--primary-dark)}
footer{margin-top:24px;max-width:520px;text-align:center;color:var(--text-light);font-size:.85rem}
`;

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} | Kreative Koala</title>
<link rel="icon" type="image/png" href="/kreative_koala_logo.png">
<style>${CSS}</style>
</head>
<body>
<a class="brand" href="/"><img src="/kreative_koala_logo.png" alt="" width="36" height="36"><span>Kreative Koala</span></a>
<main>
${bodyHtml}
</main>
<footer>${esc(ADDRESS_LINES)}</footer>
</body>
</html>
`;
}

const RESPONSE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function html(status, body, extra = {}) {
  return new Response(body, { status, headers: { ...RESPONSE_HEADERS, ...extra } });
}

// One generic page for every kind of bad link: no detail, nothing to enumerate.
const badLink = () => html(400, page('Link not valid',
  '<h1>This link is not valid</h1><p>The unsubscribe link is incomplete or has expired. Please use the link in the most recent email, or reply to that email with the word unsubscribe.</p>'));
const unavailable = () => html(503, page('Please try again',
  '<h1>Please try again later</h1><p>We could not process this request right now. You can also reply to the email with the word unsubscribe and we will remove you by hand.</p>'), { 'Retry-After': '300' });
const tooMany = () => html(429, page('Too many requests', '<h1>Too many requests</h1><p>Please wait a minute and try again.</p>'), { 'Retry-After': '60' });

const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
};

function confirmPage(app, email, actionPath) {
  return html(200, page('Unsubscribe', `<h1>Unsubscribe from ${esc(app)} announcements?</h1>
<p>Confirm to stop announcement emails from ${esc(app)} to <strong>${esc(maskEmail(email))}</strong>.</p>
<form method="post" action="${esc(actionPath)}">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">Unsubscribe</button>
</form>
<p class="muted" style="margin-top:14px">If you did not mean to open this page, just close it. Nothing has changed.</p>`));
}

function donePage(app) {
  return html(200, page('Unsubscribed', `<h1>You are unsubscribed</h1>
<p>You will not receive further announcement emails from ${esc(app)}.</p>
<p class="muted">Service and account emails (for example password resets, receipts or security notices) may still be sent if you have an account. Replies to earlier emails are also read by a person.</p>`));
}

// ---- Handler ---------------------------------------------------------------------------------------------------
export function isUnsubscribePath(pathname) {
  return pathname === '/unsubscribe' || pathname === '/unsubscribe/';
}

export async function handleUnsubscribe(request, env, { fetchImpl = fetch, now = () => new Date(), log = console.log } = {}) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return html(405, page('Not allowed', '<h1>Method not allowed</h1>'), { Allow: 'GET, HEAD, POST' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = bucketFor(ip, now().getTime());
  if (++bucket.total > MAX_TOTAL || bucket.fails >= MAX_FAILS) return tooMany();

  const secret = env.UNSUB_SECRET;
  if (!secret || String(secret).length < MIN_SECRET_LENGTH) {
    log(JSON.stringify({ evt: 'unsubscribe', outcome: 'misconfigured_secret' }));
    return unavailable();
  }

  const q = url.searchParams;
  const list = q.get('l');
  const cfg = typeof list === 'string' && Object.prototype.hasOwnProperty.call(LISTS, list) ? LISTS[list] : null;
  const emailBytes = b64urlDecode(q.get('e'));
  let email = null;
  if (emailBytes) {
    try { email = normalizeEmail(new TextDecoder('utf-8', { fatal: true }).decode(emailBytes)); } catch { email = null; }
  }
  const ok = Boolean(cfg && email && (await verify(secret, list, email, q.get('s'))));
  if (!ok) {
    bucket.fails++;
    log(JSON.stringify({ evt: 'unsubscribe', method, outcome: 'bad_link' }));
    return badLink();
  }

  const tag = await logTag(email);
  if (method !== 'POST') {
    log(JSON.stringify({ evt: 'unsubscribe', method, list, h: tag, outcome: 'page' }));
    return confirmPage(cfg.app, email, `/unsubscribe?e=${q.get('e')}&l=${list}&s=${q.get('s')}`);
  }

  const backend = BACKENDS[cfg.backend];
  if (!backend || !backend.configured(env)) {
    log(JSON.stringify({ evt: 'unsubscribe', list, h: tag, outcome: 'backend_not_configured' }));
    return unavailable();
  }
  try {
    await backend.suppress(email, `one-click link ${list} ${now().toISOString().slice(0, 10)}`, env, fetchImpl);
  } catch (err) {
    log(JSON.stringify({ evt: 'unsubscribe', list, h: tag, outcome: 'backend_error', detail: String(err && err.message).slice(0, 80) }));
    return unavailable();
  }
  log(JSON.stringify({ evt: 'unsubscribe', list, h: tag, outcome: 'suppressed' }));
  return donePage(cfg.app);
}
