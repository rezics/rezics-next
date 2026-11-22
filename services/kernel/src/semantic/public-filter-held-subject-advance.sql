WITH page AS (SELECT :end_home::integer AS end_home)
UPDATE semantic.subject_source_preparation_v1 s
SET next_home = :next_home::integer, next_ordinal = :next_ordinal::integer
FROM core.subject_subscription_v1 m, page
WHERE (s.birth,s.next_home,s.next_ordinal) = (:birth::text::bigint,:first_home::integer,:ordinal::integer)
  AND (m.birth,m.bootstrap,m.job) = (s.birth,:bootstrap::uuid,:job::uuid)
  AND CASE WHEN :after_writer::boolean THEN
    jsonb_array_length(semantic.capture_subject_access_page_v1(s.birth,s.next_home,page.end_home))
      = page.end_home - s.next_home
    ELSE true END
RETURNING s.next_home;
