CREATE TABLE reader.library_import_placement (
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  shelf text NOT NULL CHECK (shelf ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  structure text NOT NULL CHECK (structure ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 4),
  completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (agent, shelf, work)
);
