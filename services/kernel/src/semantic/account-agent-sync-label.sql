WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :type::text AS type, :release::text AS release,
         :revision::integer AS revision, :transaction_id::uuid AS transaction_id,
         :source::jsonb AS source
), labels AS MATERIALIZED (
  SELECT label.* FROM jsonb_to_recordset(:labels::jsonb) AS label(
    slot_id uuid, language text, body jsonb
  )
), removed AS (
  DELETE FROM semantic.fact fact USING input
  WHERE fact.route = input.route AND fact.subject_id = input.subject_id
    AND fact.kind = 'label' AND fact.operation = 'assert'
  RETURNING fact.slot_id
), changed AS (
  UPDATE semantic.subject subject
  SET type = input.type, current_release = input.release,
      current_facts = subject.current_facts - (SELECT count(*) FROM removed) + (SELECT count(*) FROM labels)
  FROM input
  WHERE subject.route = input.route AND subject.subject_id = input.subject_id
  RETURNING subject.subject_id
), revision AS (
  INSERT INTO semantic.revision(
    route, subject_id, revision, kind, release, recorded_transaction_id, source
  )
  SELECT input.route, input.subject_id, input.revision, 'identity', input.release,
         input.transaction_id, input.source
  FROM input
)
INSERT INTO semantic.fact(
  route, subject_id, slot_id, log_seq, operation, kind, language, body, recorded_transaction_id
)
SELECT input.route, input.subject_id, label.slot_id, 1,
       'assert', 'label', label.language, label.body, input.transaction_id
FROM input CROSS JOIN labels label CROSS JOIN (SELECT count(*) FROM removed) AS erased;
