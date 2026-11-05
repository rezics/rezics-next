SELECT s.type,s.current_release AS release,s.current_facts,s.visibility,
  EXISTS(SELECT 1 FROM semantic.account_agent_subject a WHERE a.route=s.route AND a.subject_id=s.subject_id) AS derived,
  (SELECT target::text FROM semantic.redirect d WHERE d.route=s.route AND d.subject_id=s.subject_id
   ORDER BY sequence DESC LIMIT 1) AS redirect,
  (SELECT revision FROM semantic.revision r WHERE r.route=s.route AND r.subject_id=s.subject_id
   ORDER BY revision DESC LIMIT 1) AS revision
FROM semantic.subject s WHERE s.route=:route::integer AND s.subject_id=:subject_id::uuid;
