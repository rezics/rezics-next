SELECT * FROM semantic.identity_epoch_home_gate
      WHERE route=$1 AND destination=$2 AND original=$3 FOR UPDATE;
