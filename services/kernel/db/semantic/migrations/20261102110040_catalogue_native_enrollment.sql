-- migrate:up
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
