-- This is an explicit creation-and-global-curation capability. No baseline,
-- maintainer, creator or administrator receives it implicitly.
INSERT INTO access.scope_gate(id) VALUES ('work:create:catalogue-import')
ON CONFLICT DO NOTHING;
