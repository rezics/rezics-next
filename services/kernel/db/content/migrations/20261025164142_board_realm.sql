-- migrate:up

-- Legacy boards remain readable without a Realm. New Realm boards share the
-- Realm route and reserve one concept slot per Realm.
ALTER TABLE content.board ADD COLUMN realm_id uuid;
ALTER TABLE content.board ADD CONSTRAINT board_realm_id_routed_check CHECK (
  realm_id IS NULL OR (
    realm_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11)
  )
);
ALTER TABLE content.board ADD CONSTRAINT board_realm_fk
  FOREIGN KEY (route, realm_id) REFERENCES community.realm (route, realm_id);
ALTER TABLE content.board ADD CONSTRAINT board_realm_subject_unique
  UNIQUE (route, realm_id, subject_id);

CREATE INDEX board_realm_page
  ON content.board (route, realm_id, board_id DESC)
  WHERE realm_id IS NOT NULL;

DROP TRIGGER board_identity ON content.board;
CREATE TRIGGER board_identity BEFORE UPDATE ON content.board
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'board_id', 'realm_id', 'subject_id', 'created_at');

-- migrate:down
-- Forward only: Realm ownership and the concept slot are part of board identity.
