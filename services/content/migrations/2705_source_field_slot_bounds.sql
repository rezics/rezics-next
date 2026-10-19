-- Repair already-applied 2702 as well as fresh schemas. PostgreSQL limits a
-- bounded regex repetition to 255; count the same URL-body characters separately.
ALTER TABLE source.field_support DROP CONSTRAINT field_support_slot_check;
ALTER TABLE source.field_support ADD CONSTRAINT field_support_slot_check CHECK (
  (slot ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}#[A-Za-z0-9:_.-]{1,100}$'
    OR (slot ~ '^component-property-v1#https?://[^[:space:]]+$'
      AND char_length(regexp_replace(slot, '^component-property-v1#https?://', '')) BETWEEN 1 AND 512))
  AND slot <> 'work-metadata-v1#title:en' AND slot !~ '^work-author-credit-v1#');
