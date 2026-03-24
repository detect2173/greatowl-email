-- Run this once to initialize your D1 database
-- Command: wrangler d1 execute greatowl-email-db --file=schema.sql

CREATE TABLE IF NOT EXISTS subscribers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  first_name  TEXT,
  source      TEXT DEFAULT 'landing_page',  -- where they signed up
  status      TEXT DEFAULT 'active',        -- active | unsubscribed
  tags        TEXT DEFAULT '',              -- comma-separated tags e.g. "lead,interested"
  subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address  TEXT,
  user_agent  TEXT
);

CREATE TABLE IF NOT EXISTS email_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER REFERENCES subscribers(id),
  email        TEXT NOT NULL,
  subject      TEXT NOT NULL,
  type         TEXT NOT NULL,  -- welcome | nurture | broadcast
  resend_id    TEXT,           -- ID returned by Resend API
  status       TEXT DEFAULT 'sent',
  sent_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email  ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_email_log_subscriber ON email_log(subscriber_id);
