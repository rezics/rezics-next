WITH appended AS (
  INSERT INTO rating.question_label_revision (question_id, revision, label, author_id, changed_at)
  VALUES (:question_id::uuid, :revision::integer, :label::text, :author_id::uuid, :at::timestamptz)
  RETURNING question_id, revision, label
)
UPDATE rating.question_label_head h
SET revision = a.revision, label = a.label
FROM appended a WHERE h.question_id = a.question_id;
