# Local development stack

Use Bun, Docker and Go Task (`task`, or the repository's `go-task` binary). From a fresh checkout:

```sh
bun install --frozen-lockfile
task dev:infra
task dev
```

`dev:infra` starts persistent PostgreSQL and OpenSearch, migrates Kernel and a separate `rezics_auth` database,
creates development keys and configures the Web worker. It can be repeated. Identical generated configuration is not rewritten, so repeating setup while app servers run
does not trigger configuration reloads. An interrupted setup can be repeated too.
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
importer credential through native credential authorization and writes `.temp/local-stack/seed.env` for `seed:dev`.
Native Auth startup also provisions this persona, so first-run public reads work without a separate manual bootstrap.
`seed:dev` repeats `dev:persona` before invoking the existing dump/seed producer, reloading the private `seed.env`
even on its first invocation. Keep `task dev` running and wait for normal readiness before seeding. Repeating either
task reuses the developer, account key and ordinary exposure command keys; the native local bootstrap receipt does not
restore a grant that an operator later revokes.
The persona owns the development platform governance role, including `gate:any`, Access grant authority and the
cross-media importer's subject, statement, source-statistic, source-fence and media-import permissions. The importer
client requests only its import scopes. The separate `rezics-dev-showcase` first-party client requests only Board,
thread, source-read, edition and Commerce scopes. The local stack installs that developer's direct `board:create`
grant on Global Context using a one-time native bootstrap receipt; Board creation itself uses the ordinary authenticated
`POST /v1/boards` command and current Access checks. This grants no production authority and does not change the
platform governance policy. The same person can sign into Web using the printed password. Local database setup supplies a finite
100,000-command/minute write budget for new and member accounts through the ordinary deployment override, so
a fresh persona can submit the bounded dataset batches. Explicit existing overrides are preserved; all other rate
families, authorization and operator checks retain their normal policy.

`seed:dev` first finishes the existing finite import and publication. Its local showcase stage binds the selected
VNDB `v2002` work from the returned native read identities, creates or resumes one published Global discussion Board,
confirms it in the anonymous discussion directory, then creates one original `CC-BY-4.0` thread on that Board. The
same thread supplies the exact authored source for native Content edition creation and separate publication. The
Commerce step reads the current money schema and uses its minimum configured sale amount in an ordinary offer create;
Content or the seed does not infer eligibility. The native creator edition and offer lists must both return the exact
source binding before the outcome is complete.

The local Board, thread, edition, and offer commands reuse the `showcase.sqlite` action journal, fixed command keys,
original client and credential identities. Unknown delivery retries the frozen request; refusals and unavailable
readback are recorded separately and stop the dependent steps. A successful result adds `developmentShowcase` to
`.temp/cross-media-seed/result.json`, including actual work, Board, thread, post, edition and offer IDs without
credentials. Repeating `seed:dev` resumes the same native commands. `task dev:reset` retires the complete active seed
directory first, so the new database imports and binds fresh native identities.

Decision: keep the importer client import-only, use a separate local first-party showcase client, bootstrap only
`board:create` on Global Context for the developer, and bind the ordinary published discussion Board plus authored
edition and eligible offer to the exact selected VNDB `v2002` native Subject identity.

Decision: local persona setup opens mounted anonymous GET exposure groups plus the explicit M1 `search` (path 9,
mixed Search), `search_advanced` (path 10, filters and POST `/v1/subjects:facets`), and `personal_library` for the
protected VN source-statistic writer (path 2) and personal Library (path 20), through ordinary platform
commands; `seed:dev` composes that same setup. Future additions must name a concrete M1 path here and in the bounded
list in `services/auth/scripts/dev-stack.ts`; anonymous POST routes are not scanned for openings.
Production configuration and unlisted private/write gates retain their defaults.
A public exposure opening admits that group, while ordinary route and resource permissions still apply. Kernel and
both app servers bind loopback. Do not expose this development database or host to a network.
If an opening fails, setup reports the group and native error, exits unsuccessfully and tells you which task to rerun
after resolving it. Seed does not continue after a failed persona step.

## Keys and reset

Generated Auth signing, website, importer, and staging keys and the persona password live under
`.temp/local-stack/` with private file permissions. Kernel `.env` retains separate session, receipt, write-rate, route and rating
keys across restarts, and supplies the local Auth issuer, audience and JWKS URL to both API and worker. Native Auth and the worker share Kernel's purpose-separated reference seal ring.
`apps/web/.dev.vars` contains the local website client key and loopback bindings. All generated files are ignored.
Generated bindings use literal dotenv quoting so the website JWK remains valid JSON.
Local setup also supplies a 10-second pool connection allowance for parallel cold startup on busy hosts, preserving
explicit overrides. Native request deadlines and authorization remain unchanged.
An authorized persona password rotation may retain its original registration input as `bootstrapPassword` in the
private key file; sign-in uses the current password. Database reset drops that obsolete bootstrap input before
registering the current password on the fresh database.
Local setup owns `apps/web/.dev.vars`; keep deployment secrets in deployment configuration. Production entrypoints
never import the development host or create these grants.

If a database was created from an incompatible migration baseline (for example, `relation "revision" already exists`),
stop your local `task dev` and run this one command:

```sh
task dev:reset
```

This explicitly deletes the configured local PostgreSQL container and volume, including both development databases,
then migrates fresh databases. It keeps generated keys and the OpenSearch volume, and allocates a fresh local search
namespace so generations in the deleted database cannot collide with retained indices. Ordinary setup preserves that
namespace. It retires the active local importer journals under
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
