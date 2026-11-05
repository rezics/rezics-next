-- migrate:up
-- Root registration exists before first visibility. Existing deployments are deliberately unproven.
CREATE TABLE semantic.definition_catalogue_enrollment (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  protocol integer NOT NULL CHECK (protocol IN (0,1)),
  state text NOT NULL CHECK (state IN ('unproven','open','closed')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  closed_generation bigint,
  closed_sequence bigint,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route,root_digest),
  UNIQUE (route,root_digest,closed_generation),
  FOREIGN KEY (route,root_digest) REFERENCES semantic.definition_catalogue_build(route,root_digest),
  CHECK ((protocol=0 AND state='unproven') OR (protocol=1 AND state IN ('open','closed'))),
  CHECK ((state='closed' AND closed_generation IS NOT NULL AND closed_sequence IS NOT NULL AND closed_generation=generation AND closed_sequence=last_sequence)
      OR (state<>'closed' AND closed_generation IS NULL AND closed_sequence IS NULL))
);
INSERT INTO semantic.definition_catalogue_enrollment(route,root_digest,protocol,state,recorded_transaction_id)
SELECT route,root_digest,0,'unproven',recorded_transaction_id FROM semantic.definition_catalogue_build;

CREATE TABLE semantic.definition_catalogue_consumer (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  enrollment_generation bigint NOT NULL CHECK (enrollment_generation > 0),
  -- Canonical exact locator/capture/generation, including pending Source binding. No Actor is retained.
  consumer bytea NOT NULL CHECK (octet_length(consumer) <= 8192),
  provenance bytea NOT NULL CHECK (octet_length(provenance) BETWEEN 1 AND 8192),
  dependency bytea NOT NULL CHECK (octet_length(dependency) BETWEEN 1 AND 65536),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','bound','negative','in_flight','uncertain','invalidated')),
  invalidated_generation bigint,
  -- Only an original committed Source invalidation/nonrevival producer may fill these fields.
  invalidation_receipt bytea CHECK (octet_length(invalidation_receipt) BETWEEN 1 AND 8192),
  owner_generation text,
  restore_generation text,
  PRIMARY KEY (route,root_digest,id),
  UNIQUE (route,root_digest,sequence),
  FOREIGN KEY (route,root_digest) REFERENCES semantic.definition_catalogue_enrollment(route,root_digest),
  FOREIGN KEY (route,root_digest,invalidated_generation) REFERENCES semantic.definition_catalogue_enrollment(route,root_digest,closed_generation),
  CHECK ((state='invalidated' AND invalidated_generation IS NOT NULL AND invalidation_receipt IS NOT NULL
          AND owner_generation IS NOT NULL AND restore_generation IS NOT NULL)
      OR (state<>'invalidated' AND invalidated_generation IS NULL AND invalidation_receipt IS NULL))
);
CREATE INDEX definition_catalogue_consumer_unresolved
  ON semantic.definition_catalogue_consumer(route,root_digest,sequence) WHERE state<>'invalidated';

CREATE TABLE semantic.definition_catalogue_activation (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  activation_id uuid NOT NULL,
  previous_root text,
  expected_head integer NOT NULL CHECK (expected_head >= 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','closing','invalidating','active')),
  closed_generation bigint,
  closed_sequence bigint,
  staged_sequence bigint NOT NULL DEFAULT 0 CHECK (staged_sequence >= 0),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route,root_digest),
  UNIQUE (route,activation_id),
  FOREIGN KEY (route,root_digest) REFERENCES semantic.definition_catalogue_enrollment(route,root_digest),
  CHECK (previous_root IS NULL OR previous_root<>root_digest),
  CHECK (closed_generation IS NULL OR closed_generation>=0),
  CHECK (closed_sequence IS NULL OR (closed_sequence>=0 AND staged_sequence<=closed_sequence)),
  CHECK (state NOT IN ('ready','closing') OR staged_sequence=0),
  CHECK ((state IN ('ready','closing') AND closed_generation IS NULL AND closed_sequence IS NULL)
      OR (state IN ('invalidating','active') AND closed_generation IS NOT NULL AND closed_sequence IS NOT NULL))
);
-- At most one replacement can own a visible head's cut. Crash/replay never changes its target.
CREATE UNIQUE INDEX definition_catalogue_activation_head
  ON semantic.definition_catalogue_activation(route,expected_head);
CREATE TABLE semantic.definition_catalogue_frontier (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 100),
  consumer_id text NOT NULL,
  sequence bigint NOT NULL,
  closed_generation bigint NOT NULL,
  consumer bytea NOT NULL CHECK (octet_length(consumer) <= 8192),
  provenance bytea NOT NULL CHECK (octet_length(provenance) BETWEEN 1 AND 8192),
  dependency bytea NOT NULL CHECK (octet_length(dependency) BETWEEN 1 AND 65536),
  enrollment_generation bigint NOT NULL CHECK (enrollment_generation > 0),
  consumer_state text NOT NULL CHECK (consumer_state IN ('pending','bound','negative','in_flight','uncertain')),
  PRIMARY KEY (route,root_digest,slot),
  UNIQUE (route,root_digest,consumer_id),
  FOREIGN KEY (route,root_digest) REFERENCES semantic.definition_catalogue_activation(route,root_digest)
);


-- Arrays use the public eight-axis order; no executable balance survives terminalization.
CREATE FUNCTION semantic.catalogue_work_valid(admitted bigint[], spent bigint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT array_ndims(admitted)=1 AND array_lower(admitted,1)=1 AND array_length(admitted,1)=8
 AND array_ndims(spent)=1 AND array_lower(spent,1)=1 AND array_length(spent,1)=8
 AND NOT EXISTS (SELECT 1 FROM generate_series(1,8) n
  WHERE admitted[n] IS NULL OR spent[n] IS NULL OR spent[n]<0 OR admitted[n]<spent[n]
   OR admitted[n]>9007199254740991)
$$;
CREATE TABLE semantic.definition_catalogue_original (
 route integer NOT NULL CHECK(route=0),
 original_key text NOT NULL CHECK(original_key ~ '^[a-f0-9]{64}$'),
 owner text NOT NULL CHECK(owner='semantic.catalogue'),
 root_digest text NOT NULL CHECK(root_digest ~ '^sha256:[a-f0-9]{64}$'),
 phase text NOT NULL CHECK(phase IN ('artifact','build','step','activate','activation-step')),
 origin text NOT NULL CHECK(origin IN ('command','build','activation')),
 -- Native command codec identity, hashed; no restored request or Actor is authority.
 input_digest bytea NOT NULL CHECK(octet_length(input_digest)=32),
 episode uuid NOT NULL,
 deadline_ms bigint NOT NULL CHECK(deadline_ms>0 AND deadline_ms<=9007199254740991),
 admitted bigint[] NOT NULL,
 spent bigint[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0,0]::bigint[],
 position bigint NOT NULL CHECK(position>=0),
 state text NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','spent','terminal')),
 dispatch_transaction_id uuid,
 terminal_transaction_id uuid,
 result_digest bytea CHECK(octet_length(result_digest)=32),
 PRIMARY KEY(route,original_key),
 CHECK(semantic.catalogue_work_valid(admitted,spent)),
 CHECK(state='admitted' OR spent=admitted),
 CHECK((state='admitted')=(dispatch_transaction_id IS NULL)),
 CHECK((state='terminal')=(terminal_transaction_id IS NOT NULL)),
 CHECK((state='terminal')=(result_digest IS NOT NULL))
);
CREATE INDEX definition_catalogue_original_root
 ON semantic.definition_catalogue_original(route,root_digest,original_key);
CREATE INDEX definition_catalogue_original_unsettled
 ON semantic.definition_catalogue_original(route,root_digest,original_key) WHERE state<>'terminal';
CREATE INDEX definition_catalogue_original_terminal
 ON semantic.definition_catalogue_original(route,root_digest,original_key) WHERE state='terminal';
CREATE TABLE semantic.definition_catalogue_ticket (
 route integer NOT NULL CHECK(route=0),
 original_key text NOT NULL,
 slot integer NOT NULL CHECK(slot BETWEEN 1 AND 7),
 kind text NOT NULL CHECK(kind IN ('bootstrap','authorization','framework','body','observations','lifecycle','cleanup')),
 allowance bigint[] NOT NULL,
 state text NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','spent')),
 dispatch_transaction_id uuid,
 PRIMARY KEY(route,original_key,slot),
 UNIQUE(route,original_key,kind),
 FOREIGN KEY(route,original_key) REFERENCES semantic.definition_catalogue_original(route,original_key),
 CHECK(semantic.catalogue_work_valid(allowance,ARRAY[0,0,0,0,0,0,0,0]::bigint[])),
 CHECK((state='spent')=(dispatch_transaction_id IS NOT NULL))
);
-- A position is captured from an actual body, never supplied by a workflow counter.
CREATE TABLE semantic.definition_catalogue_position (
 route integer NOT NULL CHECK(route=0),
 root_digest text NOT NULL,
 phase text NOT NULL CHECK(phase IN ('build','activation')),
 native_position bigint NOT NULL CHECK(native_position>=0),
 original_key text NOT NULL,
 recorded_transaction_id uuid NOT NULL,
 PRIMARY KEY(route,root_digest,phase,native_position),
 FOREIGN KEY(route,root_digest) REFERENCES semantic.definition_catalogue_enrollment(route,root_digest),
 FOREIGN KEY(route,original_key) REFERENCES semantic.definition_catalogue_original(route,original_key)
);
CREATE INDEX definition_catalogue_position_original
 ON semantic.definition_catalogue_position(route,original_key,root_digest,phase,native_position);
ALTER TABLE semantic.definition_catalogue_activation ADD COLUMN native_position bigint NOT NULL DEFAULT 0 CHECK(native_position>=0);
-- Reverse references are route-leading. LIMIT 1 probes never scan a whole other root.
CREATE INDEX definition_catalogue_activation_previous
 ON semantic.definition_catalogue_activation(route,previous_root,root_digest);
CREATE INDEX definition_catalogue_frontier_consumer
 ON semantic.definition_catalogue_frontier(route,consumer_id,root_digest);
CREATE INDEX definition_catalogue_consumer_invalidated
 ON semantic.definition_catalogue_consumer(route,root_digest,sequence) WHERE state='invalidated';
CREATE TABLE semantic.definition_catalogue_retirement (
 route integer NOT NULL CHECK(route=0),
 root_digest text NOT NULL,
 phase text NOT NULL DEFAULT 'captures' CHECK(phase IN ('captures','consumers','tickets','positions','terminal')),
 after_sequence bigint NOT NULL DEFAULT 0 CHECK(after_sequence>=0),
 after_original text NOT NULL DEFAULT '' CHECK(octet_length(after_original)<=64),
 recorded_transaction_id uuid NOT NULL,
 PRIMARY KEY(route,root_digest),
 FOREIGN KEY(route,root_digest) REFERENCES semantic.definition_catalogue_enrollment(route,root_digest)
);
-- Exact reverse identity survives the disappearance of the current consumer.
ALTER TABLE semantic.definition_catalogue_frontier ADD COLUMN consumer_root text;
UPDATE semantic.definition_catalogue_frontier f SET consumer_root=a.previous_root
FROM semantic.definition_catalogue_activation a WHERE a.route=f.route AND a.root_digest=f.root_digest;
ALTER TABLE semantic.definition_catalogue_frontier ALTER COLUMN consumer_root SET NOT NULL;
ALTER TABLE semantic.definition_catalogue_frontier ADD FOREIGN KEY(route,consumer_root)
 REFERENCES semantic.definition_catalogue_enrollment(route,root_digest);
CREATE INDEX definition_catalogue_frontier_reverse
 ON semantic.definition_catalogue_frontier(route,consumer_root,consumer_id,slot);
-- Historical jobs/originals are deliberately NOT backfilled as funded or settled.

-- migrate:down
-- Forward-only: deleting spent identities or reopening roots would restore authority.
