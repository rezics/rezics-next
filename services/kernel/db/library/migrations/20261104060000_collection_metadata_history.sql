-- migrate:up
CREATE TABLE library.collection_metadata_history_state (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  curator_account_id uuid NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('complete', 'partial', 'unknown')),
  known_from_revision integer NOT NULL CHECK (known_from_revision >= 1),
  pruned_before_revision integer,
  transaction_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route, collection_id),
  FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id) ON DELETE CASCADE,
  CHECK (pruned_before_revision IS NULL OR pruned_before_revision >= 1)
);

CREATE TABLE library.collection_metadata_history (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  curator_account_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 2),
  transaction_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  changed_fields text[] NOT NULL CHECK (cardinality(changed_fields) BETWEEN 1 AND 5),
  before_title text NOT NULL,
  after_title text NOT NULL,
  before_description text,
  after_description text,
  before_visibility text NOT NULL CHECK (before_visibility IN ('private', 'unlisted', 'public')),
  after_visibility text NOT NULL CHECK (after_visibility IN ('private', 'unlisted', 'public')),
  before_presentation_kind text,
  after_presentation_kind text,
  before_cover_media_id uuid,
  after_cover_media_id uuid,
  PRIMARY KEY (route, collection_id, revision),
  FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id) ON DELETE CASCADE,
  CHECK (changed_fields <@ ARRAY['title', 'description', 'visibility', 'presentationKind', 'coverMediaId']::text[])
);

-- migrate:down
DROP TABLE library.collection_metadata_history;
DROP TABLE library.collection_metadata_history_state;
