-- The native adoption shape is <=32. Address exactly one ordinal, without refill.
SELECT selection->:ordinal::integer AS selected
FROM semantic.adoption
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid
  AND context_id = '00000000-0000-8000-8000-000000000000'
ORDER BY head DESC LIMIT 1;
