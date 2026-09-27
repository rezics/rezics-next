-- Chapter composition changes use work.edit admissions; graph receipts identify the chapter subset.
CREATE INDEX studio_work_page ON access.admission (acting_subject, id)
  INCLUDE (action, registered_at) WHERE action IN ('work.create', 'work.edit') AND state = 'sealed'
    AND graph_outcome = 'succeeded';
