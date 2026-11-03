-- migrate:up
CREATE TABLE library.bangumi_upload (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  cancelled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id, upload_id)
);
CREATE TABLE library.bangumi_upload_row (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  evidence jsonb NOT NULL,
  review jsonb,
  choice jsonb,
  outcome jsonb,
  PRIMARY KEY (route, account_id, upload_id, ordinal),
  FOREIGN KEY (route, account_id, upload_id) REFERENCES library.bangumi_upload ON DELETE CASCADE,
  CHECK (octet_length(evidence::text) <= 32768)
);
-- migrate:down
DROP TABLE library.bangumi_upload_row;
DROP TABLE library.bangumi_upload;
