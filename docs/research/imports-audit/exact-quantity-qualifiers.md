# Exact-quantity conservative source handoff

The [conversion README](../../../packages/conversion/README.md#conservative-exact-quantity-source-handoff)
owns the adopted rule. This report records the frozen native
qualification-edge scenarios, the converter repair and its verification.

Every actual qualifier of an exact-quantity assertion must survive losslessly in
the same native statement through reviewed mappings and admitted schema. Any
skipped, unsupported, unresolved or semantically narrowed qualifier withholds
the whole measurement, with a diagnostic. Ordinary quantity/default behavior is
unchanged. Exactness is the closed fixed amount/unit schema, without either
uncertainty bound; serialized properties carry no exact flag.

## Actual dependency and source inspection

Base: `2e636ba926` (full revision retained in Git). The actual bundled release
was produced by `d41ac8dc6e95f61856376f697be19125d3fd7b37`, catalogue
`https://rezics.com/catalogue/rezics` version `1.0.0`, format release/1,
LinkML generator `0.17.1`. Release file SHA-256:
`87e1eb6fdec7eb1e9945342525ab08cb5c0298dbfcd2f719df4074c68baaba22`.
Wikidata converter revision is `wikidata-3`; converter file SHA-256:
`05b7d9fa8c832e8fe66730121550989a58b2cf30e2e76a800d0bbcbde890a74f`.

The implementation advances only the converter's existing revision discipline:
Wikidata is now `wikidata-4`, and the converter SHA-256 is
`c3f68292b2079fdaf6bdc3eb77f2e29249d358997dd16beee473446a03750eba`. The
bundled release remains byte-identical. Exactness is detected from the mapped
property's actual closed amount/unit value schema. Projection records loss for
unknown qualifier keys without reading their values and for mapped qualifier
snaks that cannot be normalized; emission withholds the whole exact measurement
when projection or admitted-value emission loses a qualifier. Ordinary
quantities and nonmeasurement proposals retain their existing conversion.

The actual Book property list admits schema:wordCount. Its definition maps
exactly to wd:P6570, datatype quantity, integer amount, unit 1, minimum 0,
qualifiers[]. Its value schema requires amount/unit, additionalProperties false,
and contains neither lowerBound nor upperBound. Each scenario inspects this
actual definition against the owner valueSchema API before opening native runtime.
Missing admission would be a real producer failure, never replaced with a synthetic
release or a test registration option.

Read the complete Definitions, source-inventory and conversion owner READMEs,
the exact quantity API in packages/definitions/src/index.ts and its acceptance,
book.yaml and the compiled release, and the full
[data-mapping report](../catalogue-filter-data-mappings.md). Traced actual
readDump in services/importer/src/dumps.ts, createSourceRegistration, the
Wikidata converter's projection/value/emission code, and the native import
runtime/observer and public bulk contracts. The reference index was inspected;
no external reference implementation was needed for this existing Wikidata
boundary. No external research or source copying was performed.

snaks() iterates mapped keys only. P1545 is mapped to schema:position, but
wordCount admits no qualifiers; emission diagnoses and drops that qualifier
then pushes the amount. P459 has no mapping. The released wdt:P518 also has
mappings[] and StoryArc-only targets, so the reviewed text-part qualifier is
lost already at projection. Neither property name nor a QID supplies a native
binding, and arbitrary text scope cannot be narrowed to StoryArc. Item-qualifier
emission also skips item qualifiers when encountered. The successor now marks
loss at projection and emission, so these qualification shapes cannot become an
unqualified native proposal.

## Frozen native scenarios

File: services/kernel/test/imports/exact-quantity-qualifiers.test.ts.
SHA-256: `2fa488a92eac954c63e32e63fc88695b9342385edea105181afb2a897c87b751`.
The three case bodies are unchanged; the only amendment is the authorized
`established()` helper that locates unresolved Wikidata authors by each actual
P50 `schema:sameAs` IRI.

1. `exact P6570 with mapped but unadmitted P1545 withholds the entire native measurement`
   uses the existing fixture's P1545 string position on a controlled +1450/unit1
   count. It requires a diagnostic, no proposal and no native wordCount candidate,
   while date, URL, name, author and real-shaped citations still reach candidates.
2. `reviewed letter P6570 transplanted into a controlled Book cannot lose P459 method or narrow P518 text scope`
   explicitly transplants the reviewed Q55867126 revision 1717031358 assertion
   shape: normal P6570 +1450/unit1, P459 Q718390, P518 Q63246861, no statement
   references. The observed source is a letter/text, not Book proof. External QIDs
   remain evidence; there are no native method/part IDs or positive bindings.
   Rejection requires a diagnostic and no proposal/candidate; other facts remain.
3. `native Book refresh rejects unsupported qualified exact count while preserving bootstrap receipt and changed established facts`
   first imports the actual synthetic entity.json Book with no measurement.
   A cloned source advances native lastrevid and changes name/date/URL, retaining
   existing references, then adds P6570 with the real P459 key as somevalue.
   It requires those established changes to reach actual retrieved candidates,
   while the unsupported qualified count never becomes unqualified. It retains
   original dump bytes, source identity, converter revision, subject binding,
   bootstrap serialized request/key/ACK and complete native receipt row, observed
   only by its actual full primary key. It reopens/reimports and replays the
   exact old request, requiring no duplicate effects or old receipt mutation.
   Rejection assertions run after refresh/reopen/receipt observations.

All source measurements are controlled negative qualification-edge inputs. The
baseline is specs/fixtures/imports/wikidata/entity.json, not a million-word Book
observation. Real reader, registration, converter, importer, public bulk and
Auth/Access run without a positive identifier lookup, desired UUID, SQL seed,
permission override, replacement candidate or input-rewriting transport.
Candidate observations use ordinary authenticated public editor reads. No public
adopted projection is claimed, so no synthetic adoption is used to mask rejection.

## Verification record

Continuation preflight at `72de651b22` found all three frozen native scenarios
and both owner rules already present. The test, bundled release and converter
hashes above remain unchanged. Preserve those acceptance assertions unchanged;
retry native verification against this actual base rather than manufacturing a
new fixture or treating the previous infrastructure failure as a scenario result.

Frozen tests were delivered in `17465ded7d`; continuation verification used
`15d78fd61d`. The test SHA-256 above is unchanged. Artifact acceptance
`test -s docs/research/imports-audit/exact-quantity-qualifiers.md` passed with
**exit 0**, after the wrapper's single automatic retry. It proves specification
delivery only. Log:
`.temp/goal/checks/worker-check-2026-10-29T08-08-25.808Z-80cf79bf.log`.

Commands from the worktree root:

```sh
bun scripts/worker-check.ts -- env TMPDIR=/dev/shm KERNEL_CHECK_SKIP_STALE_CLEANUP=1 bun run --cwd services/kernel check test/imports/exact-quantity-qualifiers.test.ts
bun scripts/worker-check.ts -- env TYPECHECK_CHANGED=services/kernel/test/imports/exact-quantity-qualifiers.test.ts KERNEL_CHECK_SKIP_STALE_CLEANUP=1 bun scripts/typecheck.ts
```

Focused native check: **exit 1 before test execution**. The first runner stopped
producing output after `remote-check: running on c`. The wrapper detected ten
minutes without log growth and automatically retried once under the same check ID,
`5688cee2-c7b0-42ff-a21d-66ea3a526381`. The retry failed while downloading the
repository-pinned Bun executable, with this exact first error line:

```text
curl: (56) OpenSSL SSL_read: OpenSSL/3.5.9: error:0A000126:SSL routines::unexpected eof while reading, errno 0
```

The following `gzip: stdin: unexpected end of file`, `tar: Unexpected EOF in archive`
and `remote-check: downloaded Bun does not match packageManager 1.4.4-canary.20261027.1`
confirm an incomplete tool download, not a scenario assertion. Initial log:
`.temp/goal/checks/worker-check-2026-10-29T07-58-09.419Z-a1d6044e.log`.
Retry/final log:
`.temp/goal/checks/worker-check-2026-10-29T08-08-13.689Z-2431a90d.log`.
No further native run or alternative runtime was started after that automatic retry.

Affected root typecheck: **exit 0**, checking the kernel (one of thirteen
workspaces), including construct, after the wrapper's single automatic retry.
Log: `.temp/goal/checks/worker-check-2026-10-29T08-08-15.254Z-38c95dbf.log`.
All three check IDs were awaited to a printed final exit status; none remains running.

The command requested SQLite tmpfs via TMPDIR=/dev/shm. None of the three
scenario outcomes, native candidate observations or receipt immutability assertions
was reached or verified in this continuation. Source inspection identifies the unsafe
paths; it does not substitute for the unavailable native run. No pass or red assertion
is manufactured. The tests and product code are identical to the continuation base.
No old suite, full kernel/web gate, timeout change or default converter repair ran.

## Cached-runtime verification continuation

Preflight at `4e009684d3` confirms the frozen test, actual bundled release and
converter retain the SHA-256 values recorded above. The existing conversion
README remains unchanged. This continuation runs only the focused native file
through normal worker-check admission with `TMPDIR=/dev/shm`; local `/dev/shm`
and `/tmp` are actual tmpfs mounts. The previously passing artifact acceptance
and affected root typecheck are retained without rerunning unchanged suites.

Tested checkpoint: `b0a86cb4d4`. The single focused invocation used the exact
native command above. Worker-check receipt
`b9a78c59-b604-4484-ad44-be4fd4ffa962` reached terminal **exit 1**; its recorded
status is finished. Log:
`.temp/goal/checks/worker-check-2026-10-29T10-01-41.893Z-e55e9f9c.log`.
Log SHA-256:
`f90af449d1945fa48158515b18452e734c07dfcca021c3902a3159fbf1e20eb6`.

Normal admission acquired host b after 3.147 seconds. The verified cached Bun
ran as `1.4.4-canary.1 (a0cc096ce)` and installed dependencies successfully;
the earlier TLS/archive failure did not recur. The kernel runner then failed
during its pre-test schema-dump stage, at check.ts's schemaDumps call and
database.ts's schemaDumpWith command. The exact first error line was:

```text
error: docker exec -e PGPASSWORD=rezics 6871eebd9c960ed1808e6d141b38f61f5d795197c827f92fd73b5158b4e2b7a3 pg_dump --schema-only --no-owner --no-privileges --schema=rating postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable failed:
```

The command supplied no stderr detail. This is a new tool/setup failure, not a
qualifier-loss assertion or evidence of changed admitted schema meaning. The
wrapper printed its final exit status without an automatic rerun. No second
native invocation was launched, preserving the continuation's single-run limit.
No host, runtime, timeout, product or fixture repair was attempted.

Native results remain **0 scenarios reached; no pass or product-red observed**.
There is no first native assertion failure, native candidate observation or
immutable native receipt result from this invocation. The receipt above is the
check runner's receipt only. SQLite was requested on `/dev/shm`; no scenario
opened its SQLite state before setup failed. Artifact delivery and the earlier
passing affected typecheck remain valid, but cannot replace native execution.
The test bytes, README, bundled release and converter remain unchanged; only
this declared report path changed. No outside-path file changed. No started
check remains running. Native verification is blocked on the schema-dump tool
failure; converter repair and positive whole-holder evidence remain separate.

## Converter repair verification

The converter repair is committed as revision `wikidata-4`; its current source
hash is recorded above. The focused controls cover unqualified admitted exact
input, mapped but unadmitted qualifiers, unmapped and unresolved item
qualifiers, unknown qualifier bodies that must not be read, and established
nonmeasurement statement output. The frozen native file remains byte-for-byte
unchanged at SHA-256
`55e7cdfdd0c160b5064e94809aeb998406d367977f57c35987c1a5b035e5ad3c`.

The prior focused native acceptance invocation was check
`1ece269b-28c1-45e0-9ac0-4bf73a810793`, exit **1**, log
`.temp/goal/checks/worker-check-2026-10-29T18-36-44.302Z-10f2aff4.log`.
All three frozen test bodies ran:

1. `exact P6570 with mapped but unadmitted P1545 withholds the entire native measurement`
2. `reviewed letter P6570 transplanted into a controlled Book cannot lose P459 method or narrow P518 text scope`
3. `native Book refresh rejects unsupported qualified exact count while preserving bootstrap receipt and changed established facts`

Each passed the run completion checks and observed a `schema:Book` subject,
then failed in the old property-only author query. Unresolved author candidates
are placed in a relation slot derived from their actual `schema:sameAs` IRI;
the API observer's property-only query could not locate them. The authorized
helper amendment now reads each supplied P50 target and checks its exact
sameAs-filtered public candidate, unknown value, identity qualifier and
references. That run predates the helper correction and did not reach the
measurement-withholding assertions or bootstrap receipt capture. It supplies no
receipt evidence and does not establish receipt immutability.

The focused converter check initially exposed two test-only defects: its
nonmeasurement comparison included digest-derived command keys, which correctly
change when the accepted source projection changes, and its JSON fixture type
did not admit the controlled `P6570` field. Both are corrected. The conversion
and root typecheck reruns after correction are recorded by their returned check
results. A fixed-point control now serializes `normalizedRecord` and reconverts
it with a subject binding, requiring the unknown-qualifier diagnosis and whole
measurement withholding to persist. The normalized projection retains one
actual unknown qualifier key with an empty value list, never its body; mapped
unsupported qualifiers retain their bounded normalized snaks and are rejected
again at emission. A native acceptance rerun is required after these final
converter and authorized helper changes.

## Limits and decisions

The actual bundle is consumed unchanged; no source/native revision, runtime
importer path, rights policy or definition was changed. The converter behavior
uses its existing revision and the new focused pure tests exercise the shipped
definitions without a synthetic release or guessed binding. The frozen native
case bodies remain unchanged; the only authorized amendment is the `established()`
helper, and the current complete-file hash is recorded above. All changed files
are declared paths.
Current qualifiers[] promises no positive qualified measurement case. Original
unqualified P6570 is not generated/genuine whole-holder evidence. Rejecting loss
proves neither positive provider support, measurement coverage, complete indexing
nor double-index exactness. Raw source and prior receipts stay intact.

The generic word-evidence boundary is independently adopted in the conversion
README: machine-readable whole-holder coverage, holder identity, language/version,
and a text digest only when text is supplied. A source's declared whole-work or
serial word total, or a publisher's stated word length, can be admitted without
full-text ingestion. Partial/unknown/unsupported multilingual coverage omits
wordCount evidence; summary coverage and character counts cannot substitute.
Actual typed producer grammar remains Semantic's work. This specification creates
no method, coverage, digest or scope vocabulary, no new source, and no positive
whole-scope test before that producer exists.
