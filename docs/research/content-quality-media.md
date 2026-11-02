# Content media lifecycle and collection acceptance

This note binds the uploader, media lifecycle, download disclosure, and abandoned-object work to the native checks
that own those boundaries. A test file's presence or a successful isolated-storage run does not prove that the site
Worker was run or that a live external storage service is configured.

## Production boundaries

The kernel lifecycle binding is
`services/kernel/test/content/media-native-collection-http.test.ts`. Its `createHttpMedia` fixture reserves media
through the content HTTP API, puts the original bytes into an isolated R2-compatible object store, completes through
the website-client bearer, reads the committed upload event, relays it through the registered `content` work module,
and waits for the production image workflow result. It starts the collection worker in a child process and uses
`MEDIA_NATIVE_BASE` and `MEDIA_NATIVE_CUT`, one day apart, to exercise the native collection handoff. The test
checks exact stored keys and hashes, ownership and claim state, concealed downloads before claim, successful
derivatives, collection boundaries, and retry after object deletion failure. The container, Access, receipts, events,
worker, and database are production-shaped; storage is isolated.

`services/kernel/test/content/media-lifecycle-http.test.ts` binds the available image ladder to HTTP downloads and
the 24-hour API-visible lifecycle. The default ladder has widths 320, 640, 960, 1280, 1920, and 2560 in WebP and
AVIF. It covers unavailable output, every produced variant, suspended callers, and what remains visible after
collection. `services/kernel/test/content/image-job.test.ts` uses real Sharp to check dimensions, output digests,
metadata removal, retries, and publication against collection fences.

The site Worker owns a separate binding. Run its existing transport checks with Web:

```sh
bun apps/web/scripts/focused.ts --private-network -- bun test tests/media.test.ts tests/upload-stream-lifetime.test.ts tests/thread-upload.test.ts
```

`tests/media.test.ts` exercises the Worker boundary, including uploader-token reservation reads, completion using
the Worker-measured byte count and SHA-256, and reauthorization for each derivative download. The stream-lifetime
test checks the exact streamed body, one completion, and cleanup after failures. The thread-upload tests cover
reservation identity and resume. These Worker checks must run with Web; the kernel fixture does not stand in for
that transport and this slice does not add another uploader.

The media fixtures use an isolated R2-compatible endpoint mapped to a local object store. They do not establish live
R2 credentials, bucket configuration, network access, or provider availability. Treat those as external deployment
conditions. A passing isolated lifecycle is still a useful result and must be reported separately from a live-provider
check.

## Persona jobs and native bindings

| Persona and job | Binding | User-visible assertion |
| --- | --- | --- |
| Anonymous viewer | `media-lifecycle-http.test.ts`, `media-persona-http.test.ts`, `media-realm-download-http.test.ts` | Publicly disclosed derivatives are returned; unclaimed, unavailable, or protected media stays concealed. |
| Uploader / author | `media-native-collection-http.test.ts`, `media-persona-http.test.ts` | Reserve and completion preserve uploader and container identity; the author can claim their own available media. |
| Granted member / other account | `media-native-collection-http.test.ts`, `media-realm-download-http.test.ts` | A granted account can use its own reservation; media and board grants do not replace current protected-Realm read authority. |
| Moderator | `media-persona-http.test.ts`, `media-lifecycle-http.test.ts` | A moderator can reserve and claim on their own container; moderator status does not permit impersonating another uploader. |
| Banned viewer | `media-realm-download-http.test.ts` | A protected Realm ban removes download access even when earlier media and board grants existed. |
| Suspended account | `media-persona-http.test.ts`, `media-lifecycle-http.test.ts` | Reservation, claim, and derivative download are refused for the suspended fixture. |
| Protected non-member | `media-realm-download-http.test.ts` | A non-member without `realm:read` cannot download; a board or media grant does not disclose a protected Realm object. |
| Other uploader / wrong container | `media-persona-http.test.ts`, `media-outcomes.test.ts` | Cross-uploader claims and same-partition or cross-route container mismatches fail atomically without changing references. |

The native persona fixtures use actual `ContentSystem` identities and HTTP routes. Anonymous is represented by a null
bearer, suspended by the suspended account fixture, and a banned viewer by revoking Realm access and applying the
native ban. The protected non-member is tested before a Realm grant. The media outcome suite also checks unavailable
derivatives, uploader-only originals, hidden uploaded or rejected objects, conditional downloads, parent-authority
revocation, exact 24-hour collection, and claim-versus-collection races.

## Cost-operation map

The checks below use the shared growth observer and classifier. They assert native rows, statements, and buffer work
inside the named operation; setup and unrelated history growth are outside capture. Keep the selected neighbourhood
fixed where a test declares it, and preserve the current bounds and planner settings.

| Cost operation | Native growth binding | Growth shape and covered work |
| --- | --- | --- |
| HTTP requests and trusted media jobs | `media-outcomes.test.ts` | Fixed bytes, references, lineage, and changed set at scales 32, 256, and 2048; the operation includes reservation, completion, worker image publication, download, claim/collection races, and erasure. A separate intentional changed-set series uses 1, 4, and 16 objects. |
| Reservation, completion, state reads, post claim, image publication, collection selection, and collection per object | `growth-media.test.ts` | Scales 1, 8, and 64; 100 unrelated rows are added per scale with 8192 rows of fixed indexed history. Rows and statements stay constant while block work is bounded logarithmically. The cover-reference and imported-media checks in this file are adjacent content operations, not browser-upload claims. |
| Image worker for fixed source and outputs | `image-job.test.ts` | Three-scale `checkGrowth` around a fixed Sharp input and two outputs, alongside exact output and publication assertions. |
| Partition collector | `collection-job.test.ts` | Scales 256, 1024, and 4096 with a one-object collection operation; rows and statements stay constant, block work is logarithmic, and the selected media indexes are asserted without sequential scans. |
| Registered production collection worker | `growth-media-native-collection.test.ts` | Scales 256, 1024, and 4096 on independent same-route and other-route axes. A fixed 4096-row neighbourhood is held while unrelated history grows on the other axis; the real HTTP-produced target, registered worker, deletion, retry, rows, statements, and access paths are measured. |
| Protected Realm media download | `growth-media-realm-download.test.ts` | Scales 256, 1024, and 4096 of unrelated same-home Realm, revision, ban, grant, media, and receipt history. Allowed, unknown, and denied requests are measured, including revocation at the final native authorization anchor. |

The outcome suite supplies empty, denied, unavailable, stale-authority, and lifecycle cases through the native media
driver. The growth bindings above additionally exercise a denied protected download, a fixed selection within grown
collection history, and the full upload-to-erasure lifecycle. Do not infer a separate empty-page cost curve from a
functional empty result; report only the growth cases that the selected checks actually measure.

## Commands and evidence

Run the frozen kernel acceptance from the repository root with the owning check runner:

```sh
bun run --cwd services/kernel check \
  test/content/media-outcomes.test.ts \
  test/content/media-persona-http.test.ts \
  test/content/media-lifecycle-http.test.ts \
  test/content/media-native-collection-http.test.ts \
  test/content/media-realm-download-http.test.ts \
  test/content/image-job.test.ts \
  test/content/growth-media.test.ts \
  test/content/growth-media-native-collection.test.ts \
  test/content/growth-media-realm-download.test.ts
```

Also run the additional partition-collector cost binding once:

```sh
bun run --cwd services/kernel check test/content/collection-job.test.ts
```

The native fixture requires a migrated test database through `DATABASE_URL`; it creates isolated namespaces and
uses the shared native Auth, Access, content, and work fixtures. Keep its storage endpoint isolated. The Web command
above is a separate required execution with the Web owner. Report the exact revision and command, reached assertions,
growth reports, and any `.temp` artifacts. The native registered-collection growth test writes
`.temp/goal/content-media-native-collection-growth.json`; the media outcome growth test writes
`.temp/media-growth-report.json` and per-scale request/job SQL captures. Do not commit those run artifacts.

The content capability manifest remains at its current specified-red / closed status until these native bindings
have been executed and the required promotion evidence exists. Test presence, source inspection, and isolated storage
do not advance that status.
