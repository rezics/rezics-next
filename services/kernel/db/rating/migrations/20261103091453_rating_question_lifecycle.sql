-- migrate:up
-- Lifecycle revisions are independent of immutable measurement and presentation revisions.
CREATE TABLE rating.question_lifecycle (
  question_id uuid PRIMARY KEY REFERENCES rating.question(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision BETWEEN 2 AND 2147483647),
  state text NOT NULL CHECK (state IN ('active', 'retired'))
);

-- One bounded invalidation token per Realm; an absent row is generation zero.
CREATE TABLE rating.question_lifecycle_generation (
  realm_id uuid PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation > 0)
);

-- migrate:down
-- Forward only: lifecycle decisions and their receipts must remain durable.
SELECT 1;
