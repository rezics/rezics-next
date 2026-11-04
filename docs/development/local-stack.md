# Local development stack

Use Bun, Docker and Go Task (`task`, or the repository's `go-task` binary). From a fresh checkout:

```sh
bun install --frozen-lockfile
task dev:infra
task dev
```

`dev:infra` starts persistent PostgreSQL and OpenSearch, migrates Kernel and a separate `rezics_auth` database,
creates development keys and configures the Web worker. It can be repeated. An interrupted setup can be repeated too.
`dev` also runs setup, then starts these processes together; Ctrl-C ends the processes it launched and leaves
infrastructure running. A child startup failure ends the other children.

| Service                      | Loopback address       |
| ---------------------------- | ---------------------- |
| Web                          | http://127.0.0.1:3000  |
| Auth pages and public issuer | http://127.0.0.1:4200  |
| Native Auth behind the pages | http://127.0.0.1:3100  |
| Kernel API                   | http://127.0.0.1:4100  |
| Kernel background worker     | No HTTP listener       |
| PostgreSQL                   | 127.0.0.1:54329        |
| OpenSearch                   | http://127.0.0.1:59200 |

Open Web and choose Sign in. Auth offers password sign-in, passkeys and sign-up. Sign-up works without an email
provider or Cloudflare account. The development widget completes locally; it and its verifier exist only in the
explicit local host. Use `127.0.0.1` throughout, including callbacks. Cookies are host-bound. The API token audience
remains `https://api.rezics.test`; it is an identifier, not an external network dependency. Dependency installation,
the first Docker image download and dataset downloads still need network access.

## Persona and import permissions

```sh
task dev:persona
task dev
# In another terminal, after the stack is ready:
task seed:dev
```

The one persona task provisions `developer@rezics.test`, prints its generated password and account ID, installs its
importer key through native credential authorization and writes `.temp/local-stack/seed.env` for `seed:dev`.
Native Auth startup also provisions this persona, so first-run public reads work without a separate manual bootstrap.
`seed:dev` repeats `dev:persona` before invoking the existing dump/seed producer, reloading the private `seed.env`
even on its first invocation. Keep `task dev` running and wait for normal readiness before seeding. Repeating either
task reuses the developer, importer key and ordinary exposure command keys; no manual platform grant is needed.
The persona owns the development platform governance role, including `gate:any`, Access grant authority and the
cross-media importer's subject, statement, source-statistic, source-fence and media-import permissions. The importer
client requests only its import scopes. The same person can sign into Web using the printed password. Local database setup supplies a finite
100,000-command/minute write budget for new and member accounts through the ordinary deployment override, so
a fresh persona can submit the bounded dataset batches. Explicit existing overrides are preserved; all other rate
families, authorization and operator checks retain their normal policy.

Decision: local persona setup opens mounted anonymous GET exposure groups plus the explicit M1 `search` (path 9,
mixed Search) and `search_advanced` (path 10, filters and POST `/v1/subjects:facets`) groups through ordinary platform
commands; `seed:dev` composes that same setup. Future additions must name a concrete M1 path here and in the bounded
list in `services/auth/scripts/dev-stack.ts`; anonymous POST routes are not scanned for openings.
Production configuration and private/write gates retain their defaults.
A public exposure opening admits that group, while ordinary route and resource permissions still apply. Kernel and
both app servers bind loopback. Do not expose this development database or host to a network.
If an opening fails, setup reports the group and native error, exits unsuccessfully and tells you which task to rerun
after resolving it. Seed does not continue after a failed persona step.

## Keys and reset

Generated Auth signing, website, importer, and staging keys and the persona password live under
`.temp/local-stack/` with private file permissions. Kernel `.env` retains separate session, receipt, write-rate, route and rating
keys across restarts, and supplies the local Auth issuer, audience and JWKS URL to both API and worker. Native Auth and the worker share Kernel's purpose-separated reference seal ring.
`apps/web/.dev.vars` contains the local website client key and loopback bindings. All generated files are ignored.
Local setup owns `apps/web/.dev.vars`; keep deployment secrets in deployment configuration. Production entrypoints
never import the development host or create these grants.

If a database was created from an incompatible migration baseline (for example, `relation "revision" already exists`),
stop your local `task dev` and run this one command:

```sh
task dev:reset
```

This explicitly deletes the configured local PostgreSQL container and volume, including both development databases,
then migrates fresh databases. It keeps generated keys and the OpenSearch volume. It retires the active local importer journals under
`.temp/local-stack/seed-archives/`, preserving their contents while the next seed starts without old native UUIDs. Re-run `task dev`; the persona and
public-read openings are rebuilt. This command is destructive: use it only for your own development stack, never a
shared database. It never prunes Docker. Normal `dev:infra` never resets data automatically.

Individual commands are `dev:web`, `dev:auth` (pages), `dev:auth:host`, `dev:kernel` and `dev:worker`. Complete sign-in
needs the full stack. PostgreSQL and search ports can be changed with `KERNEL_DATABASE_PORT` and `KERNEL_SEARCH_PORT`;
container and volume names can be isolated with `KERNEL_DATABASE_CONTAINER`, `KERNEL_DATABASE_VOLUME`,
`KERNEL_SEARCH_CONTAINER` and `KERNEL_SEARCH_VOLUME`. App and issuer ports above are fixed for local callbacks.

## Cross-media dump cache

`seed:dev` fetches the pinned Bangumi Archive release and a VNDB dump, verifies them, extracts source tables and seeds
Kernel over loopback HTTP. Later runs reuse the dump cache; state and the import report stay under
`.temp/cross-media-seed/`. The cache defaults to `/home/edge/projects/rezics/rezics-datasets/dumps/`;
set `REZICS_DATASETS_DUMP_CACHE` to choose another location. Bangumi is pinned by URL and SHA-256.

VNDB rotates dated files under https://dl.vndb.org/dump/. `seed:dev` first tries the inventoried dump URL. When that
file is gone (HTTP 404 or 410), it reads that dump index, selects the current `vndb-db-YYYY-MM-DD.tar.zst` (the Latest
versions destination, or the newest dated file listed), downloads it over HTTPS, and verifies tar integrity plus the
required tables and `.header` files. It records the resolved file name and SHA-256 in `vndb/manifest.json` in the dump
cache so later runs on the same machine reuse that verified archive. If the index, download or verification fails, the
seed stops; it does not continue with Bangumi alone. README.txt and schema_vndbid.sql hashes remain inventory
provenance for the inventoried dump; they are not a fetch gate for a rotated file.

Decision: local VNDB seed resolves a rotated dump from dl.vndb.org/dump, verifies structure, and pins the resolved file
plus SHA-256 in the machine cache manifest.

The seed's `REZICS_DEV_PERSONA_*`, `AUTH_ORIGIN` and `KERNEL_ORIGIN` environment seam also works with a manually
configured local account. Seed origins accept HTTPS or loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`).
