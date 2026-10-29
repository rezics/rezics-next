# Measured text assertions

This is a proposed Semantic owner decision and native specification acceptance, not
an adopted release or a delivered measurement pipeline. The owning
[Definitions README](../../../../packages/definitions/README.md) has not adopted
this association grammar. Coordinate the choice below with Semantic before changing
catalogue YAML, releases, shared schemas, converters or runtime. This document owns
only the proposed association and its native cases; the
[measurement research and complete matrix](../../../../docs/research/catalogue-filter-data-mappings.md)
remain evidence, not a competing definition authority.

## Adopted whole-holder boundary and proposed native binding

The Definitions owner has adopted generic machine-readable whole-holder coverage,
actual holder identity, language and version. Text-supplied measurements additionally
require the actual raw UTF-8 text digest, measurement instant and versioned method
Concept. A summary measures that summary only: even a digest of a complete summary
cannot prove coverage of its containing Book. An independent admitted producer
declaration must identify the measured realization and whole holder.

A reviewed producer may instead report its own declared work, serial or publisher
word total without text ingestion. That input does not require an invented text
digest, measurement instant or counting-method Concept. Preserve its actual source
convention, citation, version and date. Missing source revision stays unversioned,
with the actual raw source digest; missing dates stay absent. This is generic input,
not a Book-only branch or a restriction to owned ASCII text.

Partial, unknown and unsupported multilingual coverage retain their evidence but
omit usable word-count discovery evidence, including under NOT. Words and characters
are separate exact NONNEGATIVE INTEGER quantities, unit `1`: reject negative,
fractional, uncertain, estimated and incompatible-unit values. Explicit zero is known;
unknown, withheld and unmeasured are not zero. Edition/translation counts never
transfer through representativeEdition, series membership or parts. P518 remains
restricted to its existing StoryArc contracts.

## Closed source-input proposal

[measured-text-contract.ts](measured-text-contract.ts) exports exactly the pair
`CountProducerInput` / `CountProducerInputSchema`. It is a source-input type/schema,
not a producer factory, HTTP envelope, endpoint, import option or permission/readiness
certificate. A schema-valid object still needs reviewed producer authority, actual
native identities, lossless binding and current disclosure. The exact serialization
and vocabulary association require Semantic manager, Search and Imports review
before native acceptance freeze or definition/producer implementation.

The closed discriminated input has one actual native holder ID, producer ID, language,
version, coverage declaration and native bulk Statement. Its Statement retains all
qualifiers and references together; optional Source uses the actual bulk Source
contract unchanged. Reported input carries a declared total kind and word/character
convention; supplied-text input carries text, digest, actual instant and a method
Concept with version and definition. Coverage is an explicit enum: `whole-holder`,
`partial`, `unknown`, `unsupported-multilingual`. Included/excluded parts are declared
lists; no English parser decides eligibility. Unknown coverage cannot be upgraded by
its prose. Retained partial counts are evidence, not usable whole-holder counts.

The input uses the delivered `valueSchema('quantity', { exact: true,
integer: true, units: ['1'] })`, adding the count-specific nonnegative restriction.
Future released properties use that fixed value schema and `minimum: 0` (LinkML
`annotations.exact: true`, integer range, unit `1`, minimum zero). The generic exact
primitive remains decimal/unit-flexible; no serialized exact property flag exists.
Input schema tests supplement, never replace native property validation.

Proposed native storage keeps the existing Statement/Snak/Reference contracts:

| Position                | Term                                                               | Meaning                                                                                       |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Main                    | `schema:wordCount`                                                 | Exact nonnegative integer unit `1`, words; exact P6570                                        |
| Main alternative        | `rezics:characterCount`                                            | Distinct local character count; no guessed external exact mapping                             |
| Qualifier               | `rezics:measurementScope`                                          | String enum coverage token above, never monolingual eligibility prose                         |
| Qualifier               | `schema:inLanguage`                                                | Existing language string                                                                      |
| Qualifier               | `schema:version`                                                   | Explicit measured realization/producer-declared version; not itself a text digest             |
| Supplied-text qualifier | `rezics:measuredText`                                              | `sha256:` plus lowercase raw UTF-8 text digest                                                |
| Supplied-text qualifier | `wdt:P459`                                                         | Actual adopted versioned method Concept, `skos:Concept` target, association/inverse none      |
| Supplied-text qualifier | `rezics:measuredAt`                                                | Actual RFC 3339 millisecond UTC counting instant; native day-precision time cannot express it |
| Reference parts         | `schema:url`, `schema:version`, `schema:dateModified` when present | Actual cited record and its own version/date, distinct from measured realization              |

The citation records the complete machine declaration, included/excluded parts,
holder, version, language, value and actual method/convention together. For supplied
text it repeats the method definition, normalization, segmentation, word definition,
locale/dictionary/Unicode version and tailoring as applicable. Content snapshot digest
identifies serialized authored content, not raw manuscript bytes. Two incomplete
references, conflicting alternatives or different candidates never combine into one
eligible measurement. A qualifier token alone is a storage carrier, not an admitted
producer declaration. No native binding currently proves that admission; the tests
keep that missing prerequisite explicit rather than interpreting summary text.

String equality must admit ANY declared string within existing limits, independently
of patterns. It must not extend monolingual grammar, qualifier/leaves/depth budgets,
or add another Boolean engine. The association may store more than four qualifiers;
queries retain the current four-qualifier budget. Same-statement scope, language and
version plus method fit four; digest-specific probes are separate queries. Query
conformance is NOT YET FROZEN pending inspection/review of actual Source/index code.
The delivered exact-quantity primitive resolves the old bounds-schema blocker;
released helpers and lossless source/index binding remain separate gaps.

Withhold the entire measurement if any actual qualifier is skipped, unsupported,
unresolved or narrowed. Native source version/date absent remains absent. No
SourceRegistration option, fifth adapter, private proof or guessed identity is adopted.

## Native input proof and controlled cases

The new suite uses the actual version-1
[released discovery builder](../../test/support/released-discovery.ts), its bundled
immutable definitions and real HTTP/Auth/Access. It neither replaces the release
nor adds another builder or search engine. Methods are real created Concepts with
adopted scheme membership and URL citations to authored method definitions on
separate work subjects; the actual Concept profile has no abstract slot. IDs come from HTTP receipts.
References are existing Snak arrays, not fabricated bulk source identities.

The original owned manuscript is `Amber birds cross quiet winter fields.` Its
explicit named procedure, **Owned ASCII words v1**, counts maximal `[A-Za-z]+`
runs as words in this restricted ASCII English input. It excludes punctuation
and spaces, performs no normalization, dictionary lookup or locale tailoring,
and yields six words. **Owned ASCII characters v1** counts Unicode code points
except U+0020, includes punctuation and yields 33 characters. It deliberately
claims neither Unicode word segmentation nor extended grapheme segmentation.
These methods are suitable only for this tiny declared input domain.

The test records the actual measurement instant after counting, raw UTF-8 digest,
method definitions, returned holder and method IDs, scope, values and rights in
an authored Content record. The manuscript and record are original controlled
text licensed CC-BY-4.0. Authored `schema:abstract` is a storage carrier for the
controlled manuscript, not an inference that every summary measures a Book's
body. The supplied-text case declares partial summary coverage. Only a separate
machine whole-holder producer declaration could establish a whole-holder realization;
its actual native admission binding remains REQUIRED NOT YET FROZEN.
Public `GET /v1/documents/{id}` must return the actual snapshot, digest, licence,
origin and candidate association. Numeric fixture values alone prove none of this.

Threshold amounts 999999, 1000000 and 1000001 are separately labelled synthetic
controls with real created native publisher identities and authored declaration citations.
The reported-total case preserves holder/language/version and a serial-total convention,
without invented text/digest/measurement time/method. Its native expected-201/public-read
checks are required; the source-input model is not a delivered provider mapping. They exercise boundaries,
not a claim to have measured million-word manuscripts. They cannot establish
real Book/import-provider coverage. No copyrighted full text is fetched.

The required named cases are:

- `native measured word and character assertions preserve holder text version language method scope and evidence together`
- `edition and characters never become Book work words and incomplete crossstatement qualifiers never match`

The cases retain exact native values, qualifiers, release pins and hashed reference
parts. Compact association controls and expanded native propose/accept/adopt are
separate from the owned measurement proof. Pending alternatives and rejected,
deprecated candidates keep their own references; they do not replace selected
facts or donate qualifiers. Crossed en/v1=1000000 and ja/v2=1000001 must not satisfy
en/v1 over one million. A pair missing different qualifiers remains incomplete.
Character-only, edition-only and absent counts leave the work word property absent.
Additional native cases require explicit zero, negative/fraction/unit/bounds reject,
`somevalue`/`novalue`, omitted and unknown method, and absent source evidence.
A valid exact admission must succeed before invalid-count rejection can count;
an unsupported property failure is not the invalid-input contract.

The shared fixture exposes actual native `grant` administration. Candidate hide/restore
controls use `moderation:hide` and `moderation:takedown` on Global; source-fence
producer dependencies remain closed. Omitted/unknown method and
source-less input cases do not claim to cover actual source withdrawal. Native
method-target hiding, cited-record withdrawal and foreign source fencing remain
REQUIRED NOT YET FROZEN in the shared privacy producer; losing any indispensable dependency
must make the entire measurement unknown before disclosure, including NOT,
order, counts and membership. Do not add a fake permission or private proof.

## Consumer handoff and execution gaps

After adopted release data and Search/Commerce binding, extend the same shared
builder's measurement prerequisite with these actual native receipts. Its current
`books()` numeric controls are not this owned measurement producer. No change to
that builder, release producer, converter or runtime is included here.

The required six execution cells, as named in the
[capability manifest](../../../../docs/goals/semantic.capabilities.md), are
catalogue, curated Collection, Everything **without state**, own state, mounted
Zone and configured TypeList. Run all six for each of the three predicates:
source-scoped harem light novel; words strictly greater than 1000000; and their
conjunction. This includes the public Zone, public Collection, owner's library
without state and owner's library with state outcomes. These cells remain
TO-FREEZE after the shared Search/Commerce bindings; six input tests are not six
consumer executions. Preserve the research A–N matrix, particularly edition I,
crossed J, unknown K, invalid L and incomplete N. Exactly 1000000 fails the strict
word threshold; character-only and absent remain unknown.

Use the actual admitted page routes and native disclosure dependencies. Zone is
`POST /v1/zones/{id}:readPage`, with 200 common page or genuine retained preparation
202/no-store. A native subject read or pure grammar validation is not catalogue
execution. Search owns executable same-statement observations, scope eligibility,
current complete evidence and withheld dependency repair; Commerce owns personal
population/state support. The test's grammar assertion deliberately exposes the
missing released qualifier admission without pretending that it executes that query.
There is no second fixture/search engine or new endpoint in this proposal.

Release/export gaps: count properties, allowed qualifiers and facets are absent
or unadopted; actual measurement instants need the string term above; exact bounds
are supported by the delivered shared primitive. Data gaps: no trusted native million-word Book batch,
provider import record or production Concept binding is supplied. Runtime gaps:
qualifier-safe conversion, indexed complete associations, disclosure dependencies
and six-cell execution remain with their existing owners. Report each separately.

## Verification and freeze boundary

Format the new files before recording hashes. The manager may freeze the formatted
native acceptance after resolving the owner decisions; these bytes are a runnable
proposal, not an already approved freeze. Preserve every existing acceptance file.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/semantic/measured-text-assertions.test.ts
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

The specification intentionally requires successful property/qualifier admission
and public reads. It must expose the native failure and cannot substitute an
expected 422/400, skip, optional driver or test-only release for success.

## Cost

### Produce and read the fixed native measurement cases

- Touches: one existing driver database/Auth fixture; fixed native subjects,
  Concepts, schemes, candidates and authored Content records through ordinary
  create/propose/accept/adopt/read operations.
- Bound: fewer than 100 subject creations, 300 editorial requests and 32 authored
  records; supplied assertions have six qualifiers and at most two references. Setup
  is fixed-size and uses no history scan, unbounded retry or catalogue enumeration.
- Growth check: this specification adds no runtime operation. Shared producer and
  consumer owners retain their native growth requirements at 64/512/4096 with
  unrelated history and population grown independently; fixture size and API
  input proof do not establish engine cost or index completeness.
