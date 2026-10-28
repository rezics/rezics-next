# Measured text assertions

This is a proposed Semantic owner decision and native specification acceptance, not
an adopted release or a delivered measurement pipeline. The owning
[Definitions README](../../../../packages/definitions/README.md) has not adopted
this association grammar. Coordinate the choice below with Semantic before changing
catalogue YAML, releases, shared schemas, converters or runtime. This document owns
only the proposed association and its native cases; the
[measurement research and complete matrix](../../../../docs/research/catalogue-filter-data-mappings.md)
remain evidence, not a competing definition authority.

## Proposed owner choice

Retain the native Statement, Snak and Reference shapes. The subject addressed by
`POST /v1/subjects/{id}/candidates` is the counted holder; the assertion's returned
candidate ID and revision anchor its provenance. There is no extra measurement
endpoint, measurement subject type, importer record or caller-assigned native ID.
A trusted contributor or publisher proposes a cited measurement, an authorized
acceptor accepts it, and the ordinary Context adoption selects it. Public read is
`GET /v1/subjects/{id}`. A proposal, acceptance and selection are different states.

Use one quantity statement per measured text, language, scope and method. Proposed
terms use the existing `rezics:` namespace; these are vocabulary proposals rather
than claims that the bundled release already contains them.

| Position               | Property                  | Proposed datatype and meaning                                                                                                                                        |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main value             | `schema:wordCount`        | Exact nonnegative integer quantity, unit `1`; reviewed exact correspondence to P6570, not characters                                                                 |
| Main value alternative | `rezics:characterCount`   | Separate exact nonnegative integer quantity, unit `1`; character convention comes from the method; no external exact mapping                                         |
| Qualifier              | `rezics:measuredText`     | String `sha256:` plus 64 lowercase hex digits, over the exact identified text's UTF-8 bytes before counting transformations; content-addressed text version          |
| Qualifier              | `schema:inLanguage`       | Existing canonical BCP 47 string; the language of that measured text                                                                                                 |
| Qualifier              | `rezics:measurementScope` | English monolingual text in the initial cases, exhaustively naming included body/parts and excluded material; other declared documentation languages remain possible |
| Qualifier              | `wdt:P459`                | Item identifying an actually created/adopted, explicitly versioned method Concept; target `skos:Concept`, association relation with `inverse: none`                  |
| Qualifier              | `rezics:measuredAt`       | String containing the actual UTC RFC 3339 instant with milliseconds, e.g. `2026-10-29T00:00:00.000Z`                                                                 |
| Reference part         | `schema:url`              | Public stable citation or existing native Content document URL containing an auditable trusted assertion                                                             |
| Reference part         | `schema:version`          | Revision of that cited record; for a Content record its returned snapshot digest. This does not identify measured text                                               |

The five qualifiers are single concrete values for a usable exact measurement.
Incomplete or unknown evidence can be retained through ordinary editorial writes,
but it does not become a complete measurement and cannot satisfy a positive or
negative measurement predicate. No required-qualifier schema extension is proposed
merely to retain evidence. Duplicate/conflicting qualifier alternatives are
ambiguous and cannot be repaired by combining candidates or references.

The method Concept is a native identity, not a label lookup or a guessed external
item. Its definition names the procedure and version, definition of a word or
character, normalization, exclusions and any segmentation locale, dictionary,
Unicode version and tailoring. A changed procedure needs a distinct versioned
meaning. The cited immutable measurement record repeats the actual method
definition as measured, so subsequent Concept edits cannot rewrite old evidence.
All indispensable holder, text, language, scope, method, time and value details
must be available together in at least one reference record. Two incomplete
references cannot be joined into a fictional complete citation.

The holder is the containing native subject, not an independently assignable field.
A work measurement explicitly identifies its measured realization. Editions,
translations and languages remain separate. `representativeEdition`, edition-of,
series membership and containing parts never transfer or sum counts. A partial
body assertion cannot stand for the whole Book. Scope includes the titles,
footnotes, appendices, markup, ruby readings, whitespace and volume/part choices,
including explicit statements that a category is absent. Arbitrary body scope does
not use or widen `wdt:P518`: its existing StoryArc targets and credit/appearance
filter contracts remain intact.

`schema:version` already describes a resource version; by itself it identifies
neither measured text nor its bytes. Content's document UUID/digest identifies a
serialized authored snapshot, which is a different digest domain from raw text.
The proposed `measuredText` digest is explicit about that distinction. A digest
alone says nothing about a counting method, trust, rights or permission to ingest.

The current `time` datatype admits only year/month/day precision and midnight.
Therefore `measuredAt` is a patterned string rather than a false day-precision
measurement instant. Its producer records when counting actually occurred, not
when a fixture was seeded, when a source was fetched or when an index refreshed.

Exact zero means an explicit measured empty result under that method/scope.
Absent, `somevalue`, `novalue`, unavailable, unmeasured and withheld evidence are
unknown for this predicate, including under NOT. Negative/fractional quantities,
bounds, estimates and wrong units are not exact counts. Pages, durations, bytes,
UTF-16 units and characters do not become words. Keep rejected source evidence
without emitting a less qualified exact measurement.

## Concrete owner decisions still required

The existing release supports integer quantity patterns, minimum zero, unit lists,
string patterns, item targets and allowed qualifier lists. Those suffice for the
proposed vocabulary and ordinary storage of the association. Native statement
and bulk schemas already allow the necessary snaks and reference parts. No new
Statement object, nested private JSON payload or importer envelope is necessary.

Two shared constraints prevent adopting this as implemented:

1. `valueSchema('quantity', { integer: true, units: ['1'] })` always permits
   `lowerBound` and `upperBound`. `validateRelease` requires that exact fixed shape;
   its `minimum` does not reject a legitimate uncertainty interval. Definitions
   must choose a generic exact-quantity restriction, for example an optional
   `exact: true` annotation that omits both bounds in the fixed value schema,
   with portable/native validation and compiler support. Do not repurpose a
   string pattern to pretend a number has no bounds, or remove bounds from every
   quantity. This file does not adopt the proposed annotation's spelling.
2. Shared filter qualifiers currently admit only item equality. Language and text
   version here are strings; scope is monolingual text. Search and Semantic must
   agree how the existing shared filter grammar admits and indexes typed qualifier
   equality on the same statement. Minimal proposed first binding is canonical
   patterned string equality for language and text digest, plus item method
   equality; whole-body eligibility additionally requires the adopted scope and
   complete current evidence. Do not turn language/digests into invented Concepts
   or implement a private fixture matcher to bypass admission.

These are cross-owner contract choices, not a reason to call required 422 outcomes
complete. Stop before shared-schema/runtime implementation; preserve the native
expected-201 reds. Semantic must adopt the vocabulary in the Definitions owner
README and coordinate the exact-quantity and shared-filter decisions with their
consumers before implementation or freezing accepted hashes. No owner approval is
implied by the existence of this proposal.

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
body. The record explicitly identifies this manuscript as the work's realization.
Public `GET /v1/documents/{id}` must return the actual snapshot, digest, licence,
origin and candidate association. Numeric fixture values alone prove none of this.

Threshold amounts 999999, 1000000 and 1000001 are separately labelled synthetic
controls with the shared controlled-assertion citation. They exercise boundaries,
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

The current shared fixture has closed privacy prerequisites and exposes no native
moderation grant helper or source-fence producer. Omitted/unknown method and
source-less input cases do not claim to cover actual source withdrawal. Native
method-target hiding, cited-record withdrawal and foreign source fencing remain
required in the shared privacy producer; losing any indispensable dependency
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
missing string-qualifier admission without pretending that it executes that query.
There is no second fixture/search engine or new endpoint in this proposal.

Release/export gaps: count properties, allowed qualifiers and facets are absent
or unadopted; actual measurement instants need the string term above; exact bounds
need the shared decision. Data gaps: no trusted native million-word Book batch,
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
  records; each assertion has five qualifiers and at most two references. Setup
  is fixed-size and uses no history scan, unbounded retry or catalogue enumeration.
- Growth check: this specification adds no runtime operation. Shared producer and
  consumer owners retain their native growth requirements at 64/512/4096 with
  unrelated history and population grown independently; fixture size and API
  input proof do not establish engine cost or index completeness.
