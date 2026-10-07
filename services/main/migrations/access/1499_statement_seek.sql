-- References only. The graph owns payload, lifecycle, acceptance and disclosure.
CREATE TABLE access.statement_seek_coverage (
  data_epoch text PRIMARY KEY,
  through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
  complete boolean NOT NULL DEFAULT false
);
CREATE TABLE access.statement_seek (
  data_epoch text NOT NULL REFERENCES access.statement_seek_coverage(data_epoch) ON DELETE CASCADE,
  subject text COLLATE "C" NOT NULL,
  predicate text COLLATE "C" NOT NULL,
  meaning_key text COLLATE "C" NOT NULL,
  statement_id text COLLATE "C" NOT NULL,
  -- '*' is the ordinary inventory; other keys are finite frame reference combinations.
  frame_key text COLLATE "C" NOT NULL,
  frame_refs jsonb NOT NULL CHECK (jsonb_typeof(frame_refs) = 'array'),
  PRIMARY KEY (data_epoch, subject, frame_key, predicate, meaning_key, statement_id)
);
CREATE INDEX statement_subject_seek ON access.statement_seek
  (data_epoch, subject, predicate, meaning_key, statement_id) WHERE frame_key = '*';
CREATE INDEX statement_seek_identity ON access.statement_seek (data_epoch, statement_id);
