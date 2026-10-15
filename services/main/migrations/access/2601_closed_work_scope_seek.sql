-- Disclosure asks only whether one Work read gate is closed. Scanning every
-- open command gate to prove that absence grows with unrelated publications.
CREATE INDEX scope_gate_closed_id ON access.scope_gate(id) WHERE NOT open;
CREATE FUNCTION access.discovery_work_read_closed(resource text) RETURNS boolean
LANGUAGE sql STABLE SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT EXISTS(SELECT 1 FROM access.scope_gate WHERE id='work:read:'||resource AND NOT open);
$$;
