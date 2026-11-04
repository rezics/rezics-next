# Work release comparison card cost

`readWorkReleaseCards` receives only the disclosed rows from one inverse `schema:exampleOfWork` page. The page is
limited to 20 memberships; a request with a larger page has an unavailable comparison aggregate. The existing link
page ceiling remains `20 × 128 KiB + 64 KiB`. Cold or dirty link projections also return an unavailable comparison;
the read path does not trigger repair.

Let `M` be the supplied membership rows (`M ≤ 20`), `D` the distinct disclosed release Subjects, `H` their distinct
home partitions, `A` the admitted fields from the 12-property allowlist, `S` the scalar field slots, `Q` the admitted
relation slots, `R` the selected relation candidate keys returned for those slots, and `T` the distinct item-valued
targets in the admitted statements. From actual disclosed keys, `S ≤ D × A`, each relation slot reads at most 33
rows to detect overflow, and `R ≤ 32 × Q`; the relation key batch count is `ceil(R / 500)`. Summary batches and
transactions are `ceil(T / 256)`. The producer reads only those page and field keys. It does not issue a full Subject
read per release, search the catalogue, or walk statement history.

The fixed allowlist covers platform, language, release date/status, age, publisher, producer and developer. The
producer opens one local read transaction and routes its keyed field reads to `H` release homes; transaction controls
remain constant per producer invocation, with no transaction per field or release. Each scalar
`(release, property)` slot uses the existing current slot resolver: compact access examines at most 33 fact-log rows,
and expanded selection admits at most 32 candidates. Each relation `(release, property)` uses the existing keyed
outbound-link projection with a 33rd row as an overflow witness. More than 32 rows makes that field unavailable;
values are never truncated. For every supplied relation candidate, `currentRelationFacts` is called in batches of at
most 500 keys. Its existing limits remain 33 compact facts per slot, 32 expanded candidates per slot, provenance
batches of 256 keys and source-fence batches of 100 tuples. The inverse membership page itself continues to use the
public `currentRelationFacts` path and the private `currentRelationStatements` composition.

After the local snapshot closes, related item labels use the existing public summary reader in batches of at most 256
target IDs. It keeps related-target authorization and summary witness checks; hidden targets leave the field withheld
without a raw-ID fallback. This order releases local snapshots before summary Access preparation. Relation facts retain
their source-fence checks. Viewer action advice remains the current advice for the original work Subject and does not
change edit or publication authority.

The producer admits at most 32 statements per field, 64 qualifiers per statement, 32 references and 64 parts per
reference; each statement is at most 64 KiB UTF-8. An exceeded field budget marks that field unavailable. The complete
cards payload is limited to 2 MiB UTF-8; over-budget output makes the aggregate unavailable rather than truncating a
field or card. The web reader checks the membership page and cards against their separate ceilings.

The growth acceptance runs the composed native producer at 64, 512 and 4,096 unrelated Subjects while holding the
actual page keys fixed and adding obsolete selected-Subject history. It measures examined rows and keyed statements
from captured plans; unrelated population and obsolete history do not supply a query bound.
