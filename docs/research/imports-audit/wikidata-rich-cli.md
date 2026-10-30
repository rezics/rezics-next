# Wikidata rich CLI journey

The [frozen native acceptance](../../../services/kernel/test/imports/wikidata-rich-cli.test.ts) now calls
the ordinary `runImportCli` entry point with JSONL stdin, a privately stored operator key and the normal account,
client, Auth, API and durable-state arguments. One `openApiRuntime` owns Auth, Access, public APIs and the
registered content worker. The fixture uses the existing `identitySupport`, `openApiObserver` and runtime
`mediaBoundary` exports. It supplies bytes and schedules an interruption; it does not synthesize API replies,
receipts, authority or worker results.

## Source and decisions

The source shell is `specs/fixtures/imports/wikidata/entity.json`, with native revision 24681012. The journey
uses `wikidata-4` and the actual bundled release. It reads the existing `wikidata-native-fields.test.ts` and
`exact-quantity-qualifiers.test.ts` shapes: two names, publication date, URL, two unresolved authors, preferred
rank, position and source references. Three exact-count qualification cases are controlled transplants, not
observed Book measurements: unadmitted position, method plus text scope, and unresolved scope. No positive
whole-holder word producer or definition release is added. Existing production conversion already supports
this journey; the missing connected caller is the change.

Unknown-language terms and an unmapped qualifier, image URL and prose are hostile extras. URL presence grants
no image or prose licence. Only existing CC0 fact proposals are eligible. Relation QIDs remain citation/identity
evidence and acquire no borrowed subject bindings. Refresh increments the real record revision and changes
the supported URL. An independent Context keeps its original accepted/adopted selection.

The late-fence case interrupts an actual prepared batch before delivery, installs a facts fence through the
public API, then reopens the same durable CLI state. It observes public disclosure after reopen and preserves
the initial journal bytes, acknowledgements, candidate statements/source and receipt rows. All receipt reads
use complete native keys, and candidate reads stay within the captured subject. No SQL grants or content are
seeded by this fixture.

## Evidence and limits

The native child is exactly `Wikidata rich cited proposal CLI refresh` (one test). Its log emits credential-free
source-generation and record rows, source digests, bundle identity/digest, actual batch/fence exchanges, subject
and candidate anchors, receipt rows and worker boundary observations. The managed runner records the tested
code revision and raw log path. Private keys and SQLite state live on tmpfs and are removed when the world closes.
The source digest is the converter's normalized digest, distinct from the raw supplied record digest.

Local tests cover registered rich conversion, three-round serialized qualification rejection and malformed-tail
CLI acquisition before effects. These are local proofs, not native Auth or editor acceptance. Native growth
evidence is not produced by this focused journey; existing reader, transport, SQLite and canonical PG/derived
growth units and literal bounds remain unchanged. The source/record/command/retry ceilings are reused. No
catalogue/history scan, new growth series or claim about missing native growth counters is introduced.

Managed native acceptance must supply its exit status before this journey is described as passed.
