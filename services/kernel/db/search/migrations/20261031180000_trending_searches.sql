-- migrate:up
-- Private bounded projection, never public eligibility evidence. Current owner bindings gate activation.
CREATE TABLE search.trending_term (
  route integer NOT NULL CHECK (route = 0),
  term_key text COLLATE "C" NOT NULL CHECK (term_key ~ '^[0-9a-f]{64}$'),
  language text NOT NULL CHECK (octet_length(language) <= 35),
  source_id uuid NOT NULL,
  display text NOT NULL CHECK (octet_length(display) BETWEEN 1 AND 256),
  rank integer NOT NULL CHECK (rank BETWEEN 0 AND 16),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (route, term_key)
);
CREATE INDEX trending_term_rank ON search.trending_term(route, language, rank DESC, term_key);
CREATE INDEX trending_term_expiry ON search.trending_term(route, expires_at, term_key);
CREATE INDEX trending_term_source ON search.trending_term(route, source_id, term_key);
CREATE TABLE search.trending_member (
  route integer NOT NULL CHECK (route = 0),
  term_key text COLLATE "C" NOT NULL,
  account_id uuid NOT NULL,
  day date NOT NULL,
  contributed_at timestamptz NOT NULL,
  PRIMARY KEY (route, term_key, account_id),
  FOREIGN KEY (route, term_key) REFERENCES search.trending_term ON DELETE CASCADE
);
CREATE INDEX trending_member_account ON search.trending_member(route, account_id, term_key);
CREATE TABLE search.trending_blocked (
  route integer NOT NULL CHECK (route = 0),
  kind text NOT NULL CHECK (kind IN ('account', 'source')),
  identity uuid NOT NULL,
  PRIMARY KEY (route, kind, identity)
);

-- migrate:down
DROP TABLE search.trending_blocked, search.trending_member, search.trending_term;
