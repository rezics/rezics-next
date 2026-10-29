UPDATE semantic.identity_epoch_original SET present=false WHERE generation=$1 AND original=$2;
