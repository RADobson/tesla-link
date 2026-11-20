import { bytesToBase64Url, randomBytes } from "../lib/bytes";
import page from "./app.html";

export function renderPage(name: string, boot: unknown): Response {
  const nonce = bytesToBase64Url(randomBytes(16));
  const html = page
    .replaceAll("__PAGE__", name)
    .replaceAll("__NONCE__", nonce)
    .replace("__BOOT_JSON__", JSON.stringify(boot ?? null).replaceAll("<", "\\u003c"));
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "content-security-policy": [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        `script-src 'nonce-${nonce}'`,
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    },
  });
}
