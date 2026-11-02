-- One exact session, bounded by the native 20000-key session cap; no history scan.
DELETE FROM library.progress_unit
WHERE route = :route AND session_id = :session_id;
