-- migrate:up
CREATE INDEX verification_expiry_idx ON verification ("expiresAt", id);
CREATE INDEX verification_latest_idx ON verification (identifier, "createdAt" DESC, id DESC);

-- migrate:down
DROP INDEX verification_latest_idx;
DROP INDEX verification_expiry_idx;
