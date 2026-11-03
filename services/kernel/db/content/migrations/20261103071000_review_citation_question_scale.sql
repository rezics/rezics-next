-- migrate:up
ALTER TABLE content.revision DROP CONSTRAINT revision_vote_citation_check;
ALTER TABLE content.revision ADD CONSTRAINT revision_vote_citation_check CHECK (
  vote_citation IS NULL OR (
    jsonb_typeof(vote_citation) = 'object'
    AND vote_citation ?& ARRAY['questionId', 'units', 'revision']
    AND vote_citation - ARRAY['questionId', 'units', 'revision'] = '{}'::jsonb
    AND jsonb_typeof(vote_citation -> 'questionId') = 'string'
    AND vote_citation ->> 'questionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(vote_citation -> 'units') = 'number'
    AND (vote_citation ->> 'units') ~ '^(0|[1-9][0-9]*)$'
    AND (vote_citation ->> 'units')::numeric BETWEEN 0 AND 4096
    AND jsonb_typeof(vote_citation -> 'revision') = 'number'
    AND (vote_citation ->> 'revision') ~ '^[1-9][0-9]*$'
    AND (vote_citation ->> 'revision')::numeric <= 2147483647
  )
);

-- migrate:down
-- Forward only: immutable citations may retain widened question units.
