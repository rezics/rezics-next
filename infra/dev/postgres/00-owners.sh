#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v account_password="$REZICS_ACCOUNT_PASSWORD" \
  -v access_password="$REZICS_ACCESS_PASSWORD" \
  -v content_password="$REZICS_CONTENT_PASSWORD" \
  -v relay_password="$REZICS_RELAY_PASSWORD" <<'SQL'
CREATE ROLE account LOGIN PASSWORD :'account_password';
CREATE ROLE access LOGIN PASSWORD :'access_password';
CREATE ROLE content LOGIN PASSWORD :'content_password';
CREATE ROLE relay LOGIN PASSWORD :'relay_password';
CREATE DATABASE account OWNER account;
CREATE DATABASE access OWNER access;
CREATE DATABASE content OWNER content;
CREATE DATABASE relay OWNER relay;
SQL
