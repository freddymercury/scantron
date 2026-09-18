/**
 * Content-Security-Policy with a per-response nonce.
 *
 * The client runtime is hand-written and server-rendered (ADR-002), so inline `<script>`
 * is the normal case here rather than the exception — which makes a nonce the right lever:
 * no `'unsafe-inline'`, and a script the server did not emit cannot run. The nonce is
 * generated per response and must never be reused across responses.
 */

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    // The SSE stream (S-E3) is same-origin, so 'self' is the whole of it.
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** Applied to every response, HTML or not. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "x-frame-options": "DENY",
};

export function securityHeaders(nonce?: string): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_SECURITY_HEADERS };
  if (nonce) headers["content-security-policy"] = contentSecurityPolicy(nonce);
  return headers;
}

/** Escape text interpolated into HTML. Everything user- or source-derived goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
