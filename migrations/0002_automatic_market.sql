ALTER TABLE market_series ADD COLUMN requested_start TEXT;
ALTER TABLE market_series ADD COLUMN requested_end TEXT;
CREATE TABLE provider_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 524288),
  expires_at INTEGER NOT NULL
);
CREATE TABLE market_jobs (
  symbol TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL,
  error TEXT,
  touched_at INTEGER NOT NULL
);
CREATE TABLE market_budget (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
CREATE INDEX market_jobs_touched ON market_jobs(touched_at);
