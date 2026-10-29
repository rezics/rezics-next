UPDATE semantic.identity_epoch_dirty SET captured_revision=revision WHERE route=$1 AND original=$2;
