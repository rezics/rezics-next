UPDATE library.native_source_capture SET driver=:driver,after_key=:after,tie=:tie,session_id=:session_id,
scanned=:scanned,version=version+1 WHERE route=:route AND capture_id=:capture_id AND NOT complete;
