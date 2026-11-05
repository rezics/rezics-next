-- Only the final authorized output callback advances a pending episode after B provenance exists.
UPDATE library.collection_publication_episode
SET phase='complete',version=version+1
WHERE route=:route AND publication_id=:publication_id AND owner_account_id=:owner_account_id
  AND collection_id=:collection_id AND version=:version AND phase=:phase
RETURNING publication_id;
