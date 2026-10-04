-- Any admitted principal may create a projection: it is a derived anchor, not
-- authored content. The creation scope is one gate, as for Work and Space creation.
INSERT INTO access.scope_gate (id) VALUES ('projection:create:root') ON CONFLICT DO NOTHING;
