-- Legacy application/admission rows remain valid as single-command deliveries.
CREATE TABLE access.editorial_application_command (
  application uuid NOT NULL REFERENCES access.editorial_application(id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 2047),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 128),
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (application, position),
  UNIQUE (application, command_key)
);
CREATE TABLE access.editorial_command_binding (
  application uuid NOT NULL,
  position integer NOT NULL,
  action text NOT NULL,
  scope text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (application, position),
  FOREIGN KEY (application, position) REFERENCES access.editorial_application_command(application, position)
);
CREATE TABLE access.editorial_command_admission (
  application uuid NOT NULL,
  position integer NOT NULL,
  admission uuid NOT NULL UNIQUE REFERENCES access.admission(id),
  PRIMARY KEY (application, position),
  FOREIGN KEY (application, position) REFERENCES access.editorial_command_binding(application, position)
);
CREATE TABLE access.editorial_command_outcome (
  application uuid NOT NULL,
  position integer NOT NULL,
  outcome jsonb NOT NULL,
  PRIMARY KEY (application, position),
  FOREIGN KEY (application, position) REFERENCES access.editorial_application_command(application, position)
);
CREATE TRIGGER editorial_command_plan_immutable BEFORE UPDATE OR DELETE ON access.editorial_application_command
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_command_binding_immutable BEFORE UPDATE OR DELETE ON access.editorial_command_binding
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_command_admission_immutable BEFORE UPDATE OR DELETE ON access.editorial_command_admission
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
CREATE TRIGGER editorial_command_outcome_immutable BEFORE UPDATE OR DELETE ON access.editorial_command_outcome
  FOR EACH ROW EXECUTE FUNCTION access.editorial_immutable();
