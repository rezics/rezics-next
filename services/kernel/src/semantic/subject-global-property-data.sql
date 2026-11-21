-- Global public slots need a statement fact or a projected link in this snapshot.
WITH subject AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS id
)
SELECT EXISTS (
  SELECT FROM semantic.fact f WHERE (f.route, f.subject_id) = (s.route, s.id) AND f.kind = 'statement'
) OR EXISTS (
  SELECT FROM semantic.outbound_link l WHERE (l.route, l.subject_id) = (s.route, s.id) AND l.present AND l.relation
) AS present FROM subject s;
