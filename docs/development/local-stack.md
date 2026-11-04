# Local stack

## Seed the local stack with cross-media catalogue data

Start the local services with `task dev`, then run `task seed:dev`. The command fetches the pinned Bangumi Archive
release and VNDB dump, verifies their archive or schema fingerprints, extracts the source tables, and seeds the local
Kernel over loopback HTTP. Later runs reuse the shared dump cache. Seed state and the import report are kept under
`.temp/cross-media-seed/`.

The cache defaults to `/home/edge/projects/rezics/rezics-datasets/dumps/`. Set `REZICS_DATASETS_DUMP_CACHE` to use a
different cache location. The Bangumi archive is pinned by SHA-256; the VNDB archive is checked by tar integrity and
the pinned `README.txt` and `schema_vndbid.sql` hashes, along with every table and `.header` required by the seed.

The seed uses these origins and development-persona values:

- `KERNEL_ORIGIN`, or `http://127.0.0.1:${KERNEL_PORT:-4100}`.
- `AUTH_ORIGIN`, supplied by local Auth configuration.
- `REZICS_DEV_PERSONA_ACCOUNT_KEY`, `REZICS_DEV_PERSONA_ACCOUNT`, and `REZICS_DEV_PERSONA_CLIENT`.

The seed accepts HTTPS origins and loopback HTTP origins (`localhost`, `127.0.0.1`, or `[::1]`). The accounts
development-persona task has not landed in this checkout yet; until it does, provide the three persona values from
the configured local account. Keep its private key outside the repository.

Decision: use `REZICS_DATASETS_DUMP_CACHE` for the shared dump cache and `REZICS_DEV_PERSONA_*` as the seed's minimal environment seam until the accounts persona task supplies those values.
