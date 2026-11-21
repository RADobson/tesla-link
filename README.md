# tesla-link

GitHub Pages for tesla.dobson.website. It hosts the Tesla Fleet API public key and the OAuth callback page.

- Public key: `/.well-known/appspecific/com.tesla.3p.public-key.pem`
- OAuth redirect, no trailing slash: `/callback`

The home-energy Worker lives in [`app/`](app/README.md). It does not replace these files. When tesla.dobson.website is later served by the Worker, that app serves the same key and the same callback page.
