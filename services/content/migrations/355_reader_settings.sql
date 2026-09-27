CREATE SCHEMA IF NOT EXISTS reader;

CREATE TABLE reader.settings (
  principal_issuer text NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 300),
  principal_subject text NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 300),
  font_size smallint NOT NULL CHECK (font_size IN (15, 17, 19, 22, 25)),
  line_width text NOT NULL CHECK (line_width IN ('narrow', 'medium', 'wide')),
  typeface text NOT NULL CHECK (typeface IN ('serif', 'sans')),
  paragraph_indent boolean NOT NULL,
  theme text NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  cjk_spacing text NOT NULL CHECK (cjk_spacing IN ('auto', 'none')),
  cjk_punctuation text NOT NULL CHECK (cjk_punctuation IN ('standard', 'strict')),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_issuer, principal_subject)
);

CREATE TABLE reader.settings_command (
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_issuer, principal_subject, idempotency_key)
);
