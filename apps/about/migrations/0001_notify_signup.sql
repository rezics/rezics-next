-- People who asked to hear when registration opens: the address and the site
-- language they chose, nothing else. The address is stored lower-cased.
CREATE TABLE notify_signup (
  email TEXT PRIMARY KEY NOT NULL CHECK (length(email) <= 254),
  locale TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
