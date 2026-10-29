# Exact-quantity conservative source handoff

The [conversion README](../../../packages/conversion/README.md#conservative-exact-quantity-source-handoff)
owns the adopted rule. This report freezes native negative qualification-edge
scenarios before default converter repair; it does not repair conversion.

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
emission also skips item qualifiers when encountered. Both projection and
emission need conservative rejection in the successor; handling only mapped
qualifiers at emission misses unknown source keys.

## Frozen native scenarios

File: services/kernel/test/imports/exact-quantity-qualifiers.test.ts.
SHA-256: `55e7cdfdd0c160b5064e94809aeb998406d367977f57c35987c1a5b035e5ad3c`.

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

Frozen test revision: `edc7800dde`. The artifact acceptance is
`test -s docs/research/imports-audit/exact-quantity-qualifiers.md`; its execution
result accompanies the final handoff and proves specification delivery only.

Commands from the worktree root:

```sh
bun scripts/worker-check.ts -- env TMPDIR=/dev/shm KERNEL_CHECK_SKIP_STALE_CLEANUP=1 bun run --cwd services/kernel check test/imports/exact-quantity-qualifiers.test.ts
bun scripts/worker-check.ts -- env TYPECHECK_CHANGED=services/kernel/test/imports/exact-quantity-qualifiers.test.ts KERNEL_CHECK_SKIP_STALE_CLEANUP=1 bun scripts/typecheck.ts
```

Affected root typecheck: **exit 0**, checking the kernel (one of thirteen
workspaces), including construct. Log:
`.temp/goal/checks/worker-check-2026-10-29T05-08-37.306Z-f0e5acad.log`.

Focused native check: **infrastructure exit 1**, after the wrapper automatically
retried once under the same check ID. Both runs completed dependency installation
and reached `stack-run: kernel check local, already on a check host`, then produced
no further output. First run log:
`.temp/goal/checks/worker-check-2026-10-29T05-07-55.981Z-ebb29a59.log`.
Retry log:
`.temp/goal/checks/worker-check-2026-10-29T05-21-09.872Z-9a67a07c.log`.
The first reached failure was the wrapper's log-growth infrastructure monitor,
not a native scenario assertion. Its final exact error line was:

```text
worker-check: infrastructure failure (log did not grow for 10 minutes) on ah-ipv6; second runner failed; log .temp/goal/checks/worker-check-2026-10-29T05-21-09.872Z-9a67a07c.log
```

The command requested SQLite tmpfs via TMPDIR=/dev/shm. None of the three
scenario outcomes, native candidate observations or receipt immutability assertions
was reached or verified in this attempt. Source inspection identifies the unsafe
paths; it is not a substitute for the unavailable native run. No pass or red
assertion is manufactured. All started checks were awaited to an exit status.
No old suite, full kernel/web gate, timeout change or default converter repair ran.

## Limits and decisions

The actual bundle is consumed unchanged. No product, helper, definition, release
or existing test changes are needed. All changed files are declared paths.
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
