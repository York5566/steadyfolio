CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  delete_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 524288)
);
CREATE INDEX shares_expiry ON shares(expires_at);
CREATE TABLE share_budget (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE storage_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_budget(id, bytes) VALUES (1, 0);
CREATE TRIGGER share_size_add AFTER INSERT ON shares BEGIN
  UPDATE storage_budget SET bytes = bytes + NEW.size_bytes WHERE id = 1;
  INSERT INTO share_budget(day, count) VALUES (strftime('%Y-%m-%d', NEW.created_at, 'unixepoch'), 1)
    ON CONFLICT(day) DO UPDATE SET count = count + 1;
END;
CREATE TRIGGER share_size_subtract AFTER DELETE ON shares BEGIN
  UPDATE storage_budget SET bytes = MAX(0, bytes - OLD.size_bytes) WHERE id = 1;
END;
CREATE TABLE market_series (
  symbol TEXT PRIMARY KEY,
  metadata TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
