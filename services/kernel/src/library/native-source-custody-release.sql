UPDATE library.native_source_hold SET released=true
WHERE route=:route AND capture_id=:capture_id AND hold_id=:hold_id;
