-- First completion is serialized by the progress writer across revision selections.
CREATE INDEX progress_command_reader_completions ON structure.progress_command
  (principal_issuer, principal_subject, created_at)
  WHERE first_finish;
