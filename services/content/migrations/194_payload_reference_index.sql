-- Deletion checks only the digest neighbourhood while reference writers hold
-- the same Content advisory lock; historical erased identities are retained.
CREATE INDEX revision_live_payload_digest ON content.revision (byte_digest)
  WHERE availability <> 'erased';
CREATE INDEX representation_live_payload_digest ON media.representation (byte_digest, asset_id)
  WHERE availability <> 'erased';
