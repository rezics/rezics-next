-- Pinned allowed-input subset of Unicode UTS #39 confusables.txt, version 18.0.0
-- (2026-08-06), https://www.unicode.org/Public/security/latest/confusables.txt
-- SHA-256: 6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92
-- Unicode data terms: https://www.unicode.org/terms_of_use.html
-- Of [a-z0-9_], only 0 -> O, 1 -> l and m -> rn map. Handles are case-folded
-- before mapping; fold the skeleton too so digit zero cannot impersonate o.
CREATE FUNCTION access.handle_skeleton(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN lower(replace(translate(lower(value COLLATE "C"), '01', 'Ol'), 'm', 'rn') COLLATE "C");

ALTER TABLE access.agent_handle ADD COLUMN skeleton text
  GENERATED ALWAYS AS (access.handle_skeleton(handle)) STORED;
-- Existing lookalikes remain with their owners. New claims serialize on the
-- skeleton and probe both Agent ranges; aliases of the same owner may coexist.
CREATE INDEX agent_handle_skeleton_agent ON access.agent_handle(skeleton, agent_id);

UPDATE access.agent_handle SET retired_until = 'infinity' WHERE state = 'retired';
ALTER TABLE access.agent_handle ADD CONSTRAINT agent_handle_retirement_permanent
  CHECK (state <> 'retired' OR retired_until = 'infinity'::timestamptz);
