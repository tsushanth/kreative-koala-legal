# One-click unsubscribe (`/unsubscribe`)

A signed, one-click opt-out for announcement emails sent by the apps published under this site. It runs inside the
existing Worker (`worker.js`), which already sits in front of the static files (`run_worker_first = true`), so no other
path changes: only the exact path `/unsubscribe` is handled by new code (`src/unsubscribe.mjs`).

## Architecture

```
email (Resend)                                   kreativekoala.llc Worker                      Supabase (SummaryAI project)
  List-Unsubscribe: <https://.../unsubscribe?...>, <mailto:...>
  List-Unsubscribe-Post: List-Unsubscribe=One-Click
        |
  Gmail / Yahoo / Apple one-click  --POST-->  /unsubscribe?e=..&l=..&s=..   verify HMAC  --INSERT-->  public.outreach_suppressions
  footer link, person clicks       --GET--->  confirmation page (no writes)                           (reason 'unsubscribed')
        confirmation button        --POST-->  same as one-click
```

Sender audience queries must exclude every address in `outreach_suppressions` (see the sender-side README in the
private ops repo, `harness/lib/unsubscribe/`).

## Link format

```
https://kreativekoala.llc/unsubscribe?e=<base64url(email, trimmed + lowercased)>&l=<list id>&s=<base64url(HMAC-SHA256(UNSUB_SECRET, list + "|" + email))>
```

* base64url: RFC 4648 section 5 alphabet, no `=` padding. The Worker accepts only the canonical encoding.
* `email` in the MAC input is the lowercased, trimmed address. `list` is the list id, then a literal `|`.
* Golden vectors shared with the sender libraries live in `test/vectors.json`. Every implementation (this Worker, the
  Node and Python signers) must reproduce them byte for byte.

## Behaviour

| Request | Result |
|---|---|
| `GET` valid link | Confirmation page with an Unsubscribe button. Never writes (mail scanners and Apple Mail privacy prefetch GET links). |
| `POST` valid link (form button, or RFC 8058 body `List-Unsubscribe=One-Click`) | Inserts `(email, 'unsubscribed', 'one-click link <list> <YYYY-MM-DD>')`, shows a confirmation. Idempotent: `INSERT ... ON CONFLICT DO NOTHING` through PostgREST (`Prefer: resolution=ignore-duplicates`, no `on_conflict` column, so the primary key and any other unique index arbitrate), so a repeat or a race is still success. The body is not read. |
| Any bad link (missing or unknown list, tampered email, bad signature, garbage) | The same generic 400 page for every cause (no enumeration). No database call. |
| Backend unavailable or misconfigured | 503 with a "reply unsubscribe" fallback line; never reported as success. A missing or short `UNSUB_SECRET` fails closed. |
| Other methods | 405 |

Also: responses are `no-store`, `noindex`, `Referrer-Policy: no-referrer`, with a strict CSP and no scripts. Logs hold
only a list id, an outcome and the first 8 hex characters of SHA-256(email). Rate limiting is per Worker isolate, in
memory: 10 failed signatures per IP per minute, 120 requests per IP per minute (failures are limited tightly,
successes loosely, because mailbox providers' one-click POSTs can share IPs).

Suppression is global in v1: every list id maps to the same table, and sender audience queries exclude by address only.
Unsubscribing from one list therefore suppresses all lists. The list id is kept in `notes`.

## Secrets (set after the PR is merged, or before: secrets are per Worker, not per version)

`UNSUB_SECRET` must be identical in the Worker and in every sender's environment. Generate once, at least 32 random bytes:

```sh
cd <checkout of this repo>
UNSUB_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
printf %s "$UNSUB_SECRET" | npx wrangler secret put UNSUB_SECRET --name kreative-koala-legal
# store the same value in the password manager / the sender's environment now; it is not recoverable from Cloudflare
npx wrangler secret put SUPABASE_URL --name kreative-koala-legal           # https://<project-ref>.supabase.co
npx wrangler secret put SUPABASE_SERVICE_KEY --name kreative-koala-legal   # paste the service role / secret key
```

`wrangler secret put` deploys a new version of the current script immediately; that is safe before the route exists
(the route is simply absent). To stage a secret without deploying use `npx wrangler versions secret put <NAME>`.

Rotating `UNSUB_SECRET` invalidates every link already sent (they return the generic 400 page and the mailto fallback
still works). Do not rotate casually.

## Adding a list id

1. `src/unsubscribe.mjs`: add `xx: { app: 'AppName', backend: 'summaryai' }` to `LISTS`.
2. Same file, new backend: add an entry to `BACKENDS` with `suppress(email, note, env, fetchImpl)` and `configured(env)`,
   then point the list at it; add that backend's secrets.
3. Add the id to `KNOWN_LISTS` in both sender libraries (private ops repo), and add a test.
4. Merge. Links for an id the Worker does not know return the generic 400, so merge the Worker change first.

## Verify end to end with a canary (never a real user)

Use an address you own, for example `unsub-canary+20261113@<a domain you control>`.

```sh
export UNSUB_SECRET=...   # same value as the Worker
URL="$(node -e 'import("<ops repo>/harness/lib/unsubscribe/unsubscribe.mjs").then(m=>console.log(m.unsubscribeUrl("unsub-canary+20261113@example.com","mm")))')"
curl -s -o /dev/null -w '%{http_code}\n' "$URL"                                    # 200, confirmation page; table unchanged
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d 'List-Unsubscribe=One-Click' "$URL"   # 200; one row inserted
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d 'List-Unsubscribe=One-Click' "${URL%?}A"  # 400; nothing inserted
```

Then check the row (`select * from public.outreach_suppressions where email like 'unsub-canary+%'`), and delete it
afterwards (`delete from ... where email = '<canary>'`). Finally send one real test email through Resend with the helper's
headers to a mailbox you own, open "Show original" (headers present, DKIM/SPF/DMARC pass) and use the mailbox's own
Unsubscribe control once.

## Roll back

* Fast kill switch: `npx wrangler secret delete UNSUB_SECRET --name kreative-koala-legal`. The route then answers 503 to
  everything and writes nothing. The mailto fallback in the headers keeps working.
* Full rollback: revert the PR (removes the `/unsubscribe` branch in `worker.js`); the next Workers Build deploys the
  previous behaviour and `/unsubscribe` is a 404 again. Suppressions already written stay in the table.

## Bulk sender requirements (Gmail and Yahoo, enforced since 2024)

Apply to senders of 5,000+ messages a day to personal mailboxes; follow them regardless of volume.

* RFC 8058 one-click: `List-Unsubscribe: <https://...>` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, the
  HTTPS endpoint must accept a POST at that same URL and not require a login or extra confirmation. Both headers
  should be covered by the DKIM signature; verify with "Show original".
* SPF and DKIM pass, DMARC published, and the From domain aligned with the DKIM or SPF domain.
* Spam complaint rate in Postmaster Tools: keep it below 0.10% and never reach 0.30%.
* Honour unsubscribes within 2 days (this system is immediate). US CAN-SPAM additionally requires a working opt-out for
  30 days after sending, honouring it within 10 business days, and a postal address in the message.
* Messages to people who unsubscribed must never be sent: the audience query has to read `outreach_suppressions`
  on every send.

## Run the tests

```sh
node --test test/
npx wrangler deploy --dry-run   # config validation only; never deploys
```

## Hardening to consider (not done here)

The Worker holds a service-role key for the whole project. A tighter setup is a dedicated Postgres function
(`security definer`, insert-only into `outreach_suppressions`) exposed through PostgREST to a restricted role, so the
Worker secret cannot read or alter anything else.
