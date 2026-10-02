# Local real-world datasets

This optional corpus exercises real catalogue complexity. Ordinary `task dev`,
`task dev:seed` and `task test` do not acquire or import it. Adapter unit tests
use small independent examples; the actual corpus checks require `dataset:test`.

## Capture and scope

```sh
task dataset:fetch -- --source vndb --images covers
task dataset:fetch -- --source bangumi --images covers
task dataset:fetch -- --source musicbrainz --images covers
task dataset:verify
task dataset:test
```

Omitting `--source` elects all three providers sequentially. `--images none`
retains all image references without downloading images; `covers` downloads
all elected covers, while `all` includes character, person and screenshot
references. An actual missing image is recorded explicitly. Other network
failures on elected catalogue surfaces stop capture instead of silently reducing
the dataset. Optional artwork-service outages are recorded as unavailable,
distinct from a 404 or an empty artwork list. Successful
requests are cached so an interrupted acquisition can resume. `--refresh`
acquires a new candidate; existing snapshots remain immutable.

VNDB selects Fate titles and aliases plus official narrative-series closure from
the pinned database dump. It retains full elected scalar fields and owned tables:
releases, platforms, languages, staff aliases/credits, cast, characters, tags,
traits and their ancestors, qualified votes, images, external links and related
source identifiers. Other-franchise targets remain explicit reference records;
their unrelated neighborhoods are outside this corpus.

Bangumi selects all title/alias members of One Piece, Re:Zero and Toaru (including
Railgun and Accelerator), their narrative volumes/adaptations, and direct related
soundtracks. It retains original infobox strings, episodes, cast/staff positions,
tags, and every elected relationship row. Cross-franchise neighbors, redirects,
deleted IDs and malformed upstream rows are recorded explicitly in snapshot
scope. A shared song or crossover does not recursively elect unrelated series.

Because Archive exports only a tag subset, capture also retrieves the complete
public API JSON of every elected family subject. Original Archive fields remain
intact; API-exposed tags, counts, managed tags and image variants supplement them.
The exact public API coverage and unavailable endpoints are recorded in scope.

MusicBrainz selects the original release groups of Pink Floyd's *The Wall*, the
Beatles' white album and Glenn Gould's 1981 *Goldberg Variations*. It paginates
every release, retains every medium/track and its position, fetches full recording
records and direct artists/compositions/labels, and preserves relationship
qualifiers. Artist discographies and unrelated recordings of each composition
are outside the elected album scope. Unlike a dump, the API capture represents
an acquisition interval; totals changing during pagination cause a failure.

The snapshot's machine-readable `scope`, roots, source rows and relationships
define completeness. Full source retention does not claim that all fields have
an equivalent native REZICS owner representation. Original rights and available
provenance accompany source evidence; this tool does not publish a dataset.

## Store and replay

The default store is the main checkout's sibling `rezics-datasets` directory.
Set `REZICS_DATASET_ROOT` for another disk. `raw/blobs` holds SHA-256-addressed
bytes, `raw/requests` maps exact upstream requests to captures, and `snapshots`
holds immutable versions. Provider `*.latest.json` files select the latest frozen
version. Temporary files use `.temp/` directories; the corpus is never committed.

`verify` checks all referenced bytes and graph endpoints offline. `test` adds
provider-specific complexity and fidelity checks. To reproduce one version:

```sh
task dataset:verify -- --dataset dataset-<digest>
task dataset:test -- --dataset dataset-<digest>
```

## Public API import and URLs

Start the desired local backend and find its addresses with `task urls`.
The default importer creates/reuses a dedicated local dataset administrator.
Its random credentials are stored with mode 0600 under `.temp/datasets/`; the
bootstrap command reports only the credential file path. Existing local Account
ownership assigns its Account role through the public operator API. The explicitly
authorized Access owner bootstrap establishes the local administrator and four
scoped fixture grants, preserving existing administrators, data, policies and
recovery fences. Only this setup accesses owner stores; all dataset records and
native resources are written through existing public HTTP operations.

An existing dev stack can still name an earlier model generation after the
checked-in model changes. `task dataset:bootstrap-model` is the explicitly
authorized local owner-maintenance exception for that condition. It gracefully
stops only the selected Fuseki service, validates the replacement model head
with the pinned Jena SHACL CLI, and atomically records the new generation with
its predecessor, immutable manifest and receipt. It retains old generations and
all business data, publishes a receiver-compatible zero-event maintenance batch,
restarts the same volume, and retains the Account audit and maintenance evidence.
It refuses mismatched lineage or a closed recovery fence. It is separate from
ordinary dev/seed commands and does not change API contracts.
`REZICS_DATASET_STACK` can point to another prepared local stack directory;
`REZICS_DATASET_MAIN_ORIGIN` and `REZICS_DATASET_WEB_ORIGIN` select its public
origins. APIs and bootstrap databases must be explicit loopback endpoints.

```sh
task dataset:bootstrap-admin
task dataset:bootstrap-model
task dataset:import -- --preflight
task dataset:import -- --source vndb
task dataset:import -- --source bangumi
task dataset:import -- --source musicbrainz
```

Run the identical command again to resume. Exact request bodies are checkpointed
before dispatch and server receipts retain the returned IDs. Source observations
retain every selected record, outgoing relationship and acquisition scope.
Records exceeding the source intake's 64 KiB envelope use ordered JSON chunk
envelopes with a whole-record digest; bytes are reconstructible without loss.

Native semantic requests default to 16 items; set
`REZICS_DATASET_NATIVE_BATCH_ITEMS` to an integer from 1 to 128 for a diagnostic
or throughput run. Each request also observes the served page and byte ceilings.
Changing the batch size on resume preserves already activated child identities.
Larger requests shrink to 16 only after the owner proves their cancellation;
pending or partially staged operations retain their exact intent. Generic
source resources use one deterministic Work visibility anchor. All actual
source relationships and qualifiers remain in complete retained evidence.
Only proven cancelled or never-admitted requests may receive a corrected retry
key; ambiguous pending operations keep their original body and key. Imports of
the same snapshot, actor and backend epoch take an exclusive context lock.

Native mapping uses current Work, Agent and semantic resource commands. Tags,
characters, episodes and releases retain source-qualified descriptions. Their
source-only residuals and unsupported native owner equivalences are listed in
the import result; they are not presented as accepted classifications or invented
realizations. Full raw data remains available through source observation URLs.

`--source-only` retains evidence without native mapping. `--max-records <n>`
is an explicit partial debugging run, recorded as incomplete; it never certifies
the full corpus. Each import checkpoints bounded records and can resume initial
ingestion independently of ordinary fixture preparation. Use existing isolated
stack copies when tests mutate imported data; normal restore/startup/readiness
keeps the repository's 600-second preparation budget.

The root `urls.md` collects indexes for the current backend epoch, with
`### <title>` and all returned page/API URLs. Per-import `urls-<context>.md`
files preserve older epochs and partial runs. Tokens and passwords never enter
these indexes or source snapshots.
