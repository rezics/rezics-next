-- migrate:up
ALTER TABLE semantic.redirect DROP CONSTRAINT redirect_check;
ALTER TABLE semantic.merge_member DROP CONSTRAINT merge_member_check;

-- migrate:down
ALTER TABLE semantic.redirect
  ADD CONSTRAINT redirect_check CHECK (target < subject_id);
ALTER TABLE semantic.merge_member
  ADD CONSTRAINT merge_member_check CHECK (subject_id < member_id);
