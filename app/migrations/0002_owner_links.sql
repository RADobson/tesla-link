-- One-time owner connect links. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS owner_links (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('tesla', 'sigen')),
  expires_at INTEGER NOT NULL
);
