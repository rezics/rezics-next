CREATE TABLE reader.library_import_daily_budget (
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  day date NOT NULL,
  searches integer NOT NULL DEFAULT 0 CHECK (searches BETWEEN 0 AND 200),
  acquisitions integer NOT NULL DEFAULT 0 CHECK (acquisitions BETWEEN 0 AND 50),
  PRIMARY KEY (agent, day)
);
