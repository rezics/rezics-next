INSERT INTO rating.question
  (id, owner_id, realm_id, revision, meaning, label, grain, minimum_units, maximum_units, step_units)
VALUES
  (:id::uuid, :owner_id::uuid, :realm_id::uuid, 1, :meaning::text, :label::text, :grain::text,
   :minimum_units::integer, :maximum_units::integer, :step_units::integer);
