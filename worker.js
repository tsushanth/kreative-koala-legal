// Thin wrapper around the static assets: HTTP -> HTTPS, security headers, /account-deletion alias,
// and the signed one-click /unsubscribe route (src/unsubscribe.mjs; docs/unsubscribe/README.md).
import { handleUnsubscribe, isUnsubscribePath } from './src/unsubscribe.mjs';

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "form-action 'self' https://formsubmit.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/account-deletion' || url.pathname === '/account-deletion/') {
      url.pathname = '/delete-account';
      return Response.redirect(url.toString(), 301);
    }
    if (isUnsubscribePath(url.pathname)) {
      return handleUnsubscribe(request, env);
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('Strict-Transport-Security', 'max-age=31536000');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if ((headers.get('Content-Type') || '').startsWith('text/html')) {
      headers.set('Content-Security-Policy', CSP);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
