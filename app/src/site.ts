import callbackHtml from "../../callback/index.html";
import publicKeyPem from "../../.well-known/appspecific/com.tesla.3p.public-key.pem";

const PEM_PATH = "/.well-known/appspecific/com.tesla.3p.public-key.pem";

export function siteResponse(url: URL): Response | null {
  if (url.pathname === PEM_PATH) {
    return new Response(publicKeyPem, {
      headers: {
        "content-type": "application/x-pem-file; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (url.pathname === "/callback" || url.pathname === "/callback/") {
    return new Response(callbackHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return null;
}
