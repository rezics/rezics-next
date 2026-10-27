# Library profile ABI proposal

[Library and Collections](../../../docs/library-and-collections.md) is the authority: they are one capability,
configured through definitions. This document proposes the definitions ABI and its executable acceptance surface;
it does not replace a consumer agreement. No agreed Commerce field shape is present in this checkout. The names
below are a concrete proposal for that agreement, not an assertion that the illustrative research JSON was adopted.
There is no product implementation in this change. The new tests intentionally fail on missing compiler/schema/data
support, while importing only entrypoints that already exist. Actual row replay and migration remain subsequent
Commerce API acceptance, not package test outcomes.

The inherited annotation follows the existing `cover_ratio` source path and `coverRatio` output precedent.
`bases` remains ancestry metadata, never instructions for a runtime walk. Source: class `annotations.library`
is a native YAML mapping (also a JSON object when schemas are supplied as JSON), not JSON text in a scalar.
Its fields equal the compiled profile below, except that every `labels` member is absent in source.
No separate global profile registry or mutable profile lookup is introduced.

## Source and presentation

```yaml
classes:
  ReadingBase:
    abstract: true
    annotations:
      library:
        id: book.reading
        revision: 1
        entryStateSet:
          id: legacy-five
          states:
            - { id: planned, role: planned }
            - { id: in_progress, role: active }
            - { id: completed, role: completed }
            - { id: paused, role: paused }
            - { id: dropped, role: dropped }
        units:
          - { id: page, dimension: count, precision: 0, minimum: 0, maximum: 999999999999 }
        progress:
          - { mode: scalar_amount, units: [page], totalPolicy: optional }
        copies:
          - { id: physical, statuses: [{ id: owned }, { id: disposed }] }
          - { id: digital, statuses: [{ id: owned }] }
        importSources: []
```

For a declaration in `catalogue/book.yaml`, labels live only in
`presentation/book/{locale}.yaml` under `libraryProfiles["book.reading"]`:

```yaml
libraryProfiles:
  book.reading:
    profile: library
    stateSet: state
    states: { planned: Planned, in_progress: In progress, completed: Completed, paused: Paused, dropped: Dropped }
    units: { page: page }
    copyKinds: { physical: physical, digital: digital }
    copyStatuses:
      physical: { owned: owned, disposed: disposed }
      digital: { owned: owned }
    importSources: {}
```

These are leaf strings, compiled into `labels[locale]` on the corresponding profile, state set, state, unit,
kind, status or source. English is required for each leaf; the launch data requires all eight UI locales
`de/en/es/fr/ja/ko/zh-Hans/zh-Hant`. Reject unknown profile/member/locale keys, duplicate contributions, misplaced
homes, missing English and labels longer than 80 Unicode code points or empty labels. Inheritance copies the
already labelled declaration; a child does not relabel its inherited profile in its own presentation home.
An override has a new profile ID and its own home. Neither labels nor semantic roles are identifiers.
Presentation objects are closed: exactly `profile`, `stateSet`, `states`, `units`, `copyKinds`, `copyStatuses`,
`importSources`; each map admits only IDs actually declared in that profile (statuses are nested by kind).
Profile maps contain at most the number of declarations in their bounded source schemas.

## Closed TypeScript output

All object members below are exhaustive. JSON Schema and runtime validation reject extra members recursively;
TypeScript alone does not enforce exact objects. `TypeDefinition` gains only optional `library?: LibraryProfile`.
Absence is distinct from a present profile with empty progress/copies/importSources.

```ts
type Locale = 'de' | 'en' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant';
type Labels = { en: string } & Partial<Record<Exclude<Locale, 'en'>, string>>;
type LocalId = string; // ^[a-z][a-z0-9_]{0,31}$, end anchored against trailing newline
type ScopedId = string; // ^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$
type UnitId = 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
type Named = { id: LocalId; labels: Labels };
type LibraryProfile = {
  id: ScopedId;
  revision: number; // integer 1..2147483647
  labels: Labels;
  entryStateSet: Named & {
    states: (Named & { role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped' })[];
  };
  units: {
    id: UnitId;
    labels: Labels;
    dimension: 'count' | 'duration' | 'ratio';
    precision: number;
    minimum: number;
    maximum: number;
  }[];
  progress: { mode: ProgressMode; units: UnitId[]; totalPolicy: 'optional' | 'forbidden' | 'fixed_100' }[];
  copies: (Named & { statuses: Named[] })[];
  importSources: {
    id: ScopedId;
    labels: Labels;
    mappingVersion: LocalId;
    types: string[]; // exact accepting type CURIEs in this release
    recordKinds: ('entry_state' | 'progress' | 'holding' | 'observation')[];
  }[];
};
type LibraryProfilePin = {
  releaseDigest: string; // ^sha256:[0-9a-f]{64}$, immutable release address
  type: string; // accepting type CURIE, not a structural source class name
  profileId: ScopedId;
  profileRevision: number;
};
```

IDs are scoped as `(profileId, stateSet.id, state.id)`, `(profileId, unit.id)`,
`(profileId, copyKind.id, status.id)`, and `(profileId, importSource.id, mappingVersion)`.
Each declaring class owns one profile ID per release; duplicates across distinct declarations are rejected even
if byte identical. Repeated inherited copies are permitted. A profile revision is not a release address.
The accepting type remains in the pin even when several types inherit the same declaration.

## Closed JSON Schema fragment

Add `library: { "$ref": "#/$defs/libraryProfile" }` to the existing closed type schema, without making it
required. This fragment defines all new shapes. `typeCurie` reuses the release's existing `curie` definition.
Patterns use the repository's strict end-anchor convention. Numeric cross-field rules, unique IDs, references
and canonical byte limits are semantic validation shared by compiler and `validateRelease`, not just schema rules.
Source validation uses the same structure with `labels` removed, then attaches presentation before release validation.

```json
{
  "$defs": {
    "libraryLocalId": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,31}$(?![\\s\\S])" },
    "libraryScopedId": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,31}$(?![\\s\\S])" },
    "libraryLabels": {
      "type": "object",
      "required": ["en"],
      "additionalProperties": false,
      "maxProperties": 8,
      "patternProperties": {
        "^(?:de|en|es|fr|ja|ko|zh-Hans|zh-Hant)$(?![\\s\\S])": { "type": "string", "minLength": 1, "maxLength": 80 }
      }
    },
    "libraryUnitId": { "enum": ["page", "chapter", "episode", "volume", "minute", "percent"] },
    "libraryNamed": {
      "type": "object",
      "required": ["id", "labels"],
      "additionalProperties": false,
      "properties": { "id": { "$ref": "#/$defs/libraryLocalId" }, "labels": { "$ref": "#/$defs/libraryLabels" } }
    },
    "libraryState": {
      "type": "object",
      "required": ["id", "labels"],
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/libraryLocalId" },
        "labels": { "$ref": "#/$defs/libraryLabels" },
        "role": { "enum": ["planned", "active", "completed", "paused", "dropped"] }
      }
    },
    "libraryStateSet": {
      "type": "object",
      "required": ["id", "labels", "states"],
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/libraryLocalId" },
        "labels": { "$ref": "#/$defs/libraryLabels" },
        "states": { "type": "array", "minItems": 1, "maxItems": 16, "items": { "$ref": "#/$defs/libraryState" } }
      }
    },
    "libraryUnit": {
      "type": "object",
      "required": ["id", "labels", "dimension", "precision", "minimum", "maximum"],
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/libraryUnitId" },
        "labels": { "$ref": "#/$defs/libraryLabels" },
        "dimension": { "enum": ["count", "duration", "ratio"] },
        "precision": { "type": "integer", "minimum": 0, "maximum": 6 },
        "minimum": { "type": "number", "minimum": 0, "maximum": 999999999999 },
        "maximum": { "type": "number", "minimum": 0, "maximum": 999999999999 }
      }
    },
    "libraryProgress": {
      "type": "object",
      "required": ["mode", "units", "totalPolicy"],
      "additionalProperties": false,
      "properties": {
        "mode": { "enum": ["scalar_amount", "cursor_position", "completed_units"] },
        "units": {
          "type": "array",
          "minItems": 1,
          "maxItems": 6,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/libraryUnitId" }
        },
        "totalPolicy": { "enum": ["optional", "forbidden", "fixed_100"] }
      }
    },
    "libraryCopyKind": {
      "type": "object",
      "required": ["id", "labels", "statuses"],
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/libraryLocalId" },
        "labels": { "$ref": "#/$defs/libraryLabels" },
        "statuses": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "$ref": "#/$defs/libraryNamed" } }
      }
    },
    "libraryImportSource": {
      "type": "object",
      "required": ["id", "labels", "mappingVersion", "types", "recordKinds"],
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/libraryScopedId" },
        "labels": { "$ref": "#/$defs/libraryLabels" },
        "mappingVersion": { "$ref": "#/$defs/libraryLocalId" },
        "types": {
          "type": "array",
          "minItems": 1,
          "maxItems": 16,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/curie" }
        },
        "recordKinds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "uniqueItems": true,
          "items": { "enum": ["entry_state", "progress", "holding", "observation"] }
        }
      }
    },
    "libraryProfile": {
      "type": "object",
      "required": ["id", "revision", "labels", "entryStateSet", "units", "progress", "copies", "importSources"],
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/libraryScopedId" },
        "revision": { "type": "integer", "minimum": 1, "maximum": 2147483647 },
        "labels": { "$ref": "#/$defs/libraryLabels" },
        "entryStateSet": { "$ref": "#/$defs/libraryStateSet" },
        "units": { "type": "array", "maxItems": 6, "items": { "$ref": "#/$defs/libraryUnit" } },
        "progress": { "type": "array", "maxItems": 3, "items": { "$ref": "#/$defs/libraryProgress" } },
        "copies": { "type": "array", "maxItems": 4, "items": { "$ref": "#/$defs/libraryCopyKind" } },
        "importSources": { "type": "array", "maxItems": 8, "items": { "$ref": "#/$defs/libraryImportSource" } }
      }
    }
  }
}
```

## Resolution, compatibility and bounds

Walk the existing single `is_a` ancestry at compile time, nearest class first, including abstract classes without
CURIEs. The first explicitly declared profile wins as a whole. No list union, field fallback, mutation or
shared mutable output objects. No declaration means omit `library`, including after recompiling older sources.
`null`, booleans, arrays and scalar annotations are invalid; `{}` is not suppression. Multiple parents/mixins
remain outside the existing LinkML subset. Reject ambiguous concrete declarations sharing a CURIE before any
order-dependent choice; reject duplicate profile IDs across declaring classes. Stable source pointers and sorted,
capped diagnostics follow `CatalogueError`. Profile declaration order and state order are presentation data;
identical source compiles deterministically, without sorting a state's display order by its label.

All IDs must be unique within their scope (state IDs, unit IDs, modes, units per mode, kind IDs, status IDs per
kind, source IDs, source types and record kinds). References must exist in this release; every progress unit must
be declared in the same effective profile. Import `types` is an exact compatibility allowlist; an inherited
profile does not expand that list. Unsupported writes to a descendant are rejected rather than searched in bases.

Counts have dimension `count`, integer precision zero and integer bounds. Minutes have dimension `duration`;
percent has dimension `ratio`, bounds exactly 0 and 100 and precision 0..6. Minimum must not exceed maximum;
bounds must be representable at the declared decimal precision. All numeric magnitudes stay within the existing
12-integer-digit/6-fractional-digit engine contract. No implicit conversions between dimensions or units.
`scalar_amount` admits declared count, minute and percent units; total policy is `optional` for count/minute and
`fixed_100` for percent. `cursor_position` admits only count units, with `forbidden` totals. One rule per mode;
a scalar rule cannot mix percent with count/minute because their total policies differ.

`completed_units` remains the existing sparse-set algorithm, not a count or achievement algorithm. There is no
accepted stable unit identity plus structure-revision binding in this checkout, so all profile declarations of
that mode fail semantic validation for now. Its enum name stays reserved to the existing algorithm; nothing
adds a fourth mode. A later agreed identity contract must be explicitly admitted by the closed schema before
sparse units become configurable. Do not fabricate an achievement provider contract. The current launch profiles
select scalar progress; tests also accept cursor on page units. Repeated recipe cooks are repeated sessions,
not invented completed-unit IDs.

Kinds define allowed pairs by containment: `digital/owned` and `physical/disposed` are allowed; `digital/disposed`
is not in the proposed launch data. These are private personal assertions, including digital ownership wording,
never access rights or entitlements. Attributes have no admitted field in this revision. Future platform, store,
condition and provenance attributes require a closed, bounded typed schema extension, not an opaque object.
Import descriptors are declarations only. Stable source and mapping IDs never enable adapters. No credentials,
URLs/endpoints, permissions, executable mappings or enablement flags are accepted anywhere in a profile.
`observation` is a distinct record kind, never an assertion or an automatic holding. Launch import arrays are
empty: the synthetic `fixture.manual` mapping in tests makes no provider capability claim.

Each compiled effective profile is at most 16 KiB of canonical UTF-8 JSON, including labels, and is charged once
per accepting type in the complete canonical release. Array caps are in the schema; the complete release remains
at most 4 MiB, 1,024 types and 4,096 properties. Check bytes before expensive semantic validation. Compilation and
validation touch only supplied schema/presentation/profile bytes, O(total bytes) under the existing source and
ancestry caps; memoize nearest declaration resolution rather than repeating ancestry walks per consumer. Detect
identity duplicates with bounded maps. Consumers perform one fixed bounded lookup in the pinned release.
No SQL, account traversal, profile service, table, deployment or per-vertical backend path is needed.

## Launch declarations and migration profile

These exact catalogue classes were inspected; do not annotate Thing, CreativeWork, LaunchWork or unrelated agents
and concepts. All launch declarations use `legacy-five`, preserving `planned/in_progress/completed/paused/dropped`
and the corresponding roles in the example. All use physical `{owned, disposed}` and digital `{owned}` pairs,
with private assertion meaning. A printed recipe copy is a personal holding assertion too. Work and edition/release
remain distinct accepting types, not implicit redirects. A future profile can use different IDs and omit roles;
independent labels and wishlist membership coexist through Commerce's generic capability, outside this ABI.

| Source            | Declaring class  | Accepting type                          | Profile ID           | Scalar unit |
| ----------------- | ---------------- | --------------------------------------- | -------------------- | ----------- |
| book.yaml         | Work             | schema:Book                             | book.reading         | page        |
| book.yaml         | Edition          | bf:Instance                             | book.edition         | page        |
| anime.yaml        | TVSeries         | schema:TVSeries                         | anime.series         | episode     |
| anime.yaml        | TVSeason         | schema:TVSeason                         | anime.season         | episode     |
| anime.yaml        | Episode          | schema:Episode                          | anime.episode        | minute      |
| anime.yaml        | Movie            | schema:Movie                            | anime.film           | minute      |
| game.yaml         | VideoGame        | schema:VideoGame (via BangumiVideoGame) | game.playing         | minute      |
| game.yaml         | VideoGameRelease | wd:Q20631656                            | game.release         | minute      |
| game.yaml         | GameAddOn        | wd:Q209163                              | game.addon           | minute      |
| visual-novel.yaml | VisualNovel      | wd:Q689445                              | visual-novel.reading | percent     |
| recipe.yaml       | Recipe           | schema:Recipe                           | recipe.cooking       | minute      |

Persist the complete `LibraryProfilePin` with each accepted fact/session/copy or its immutable accepting revision.
Resolve exactly `release.types[pin.type].library`; verify profile ID and revision match. No cross-release search,
mutable global profile resolution or runtime base walk. Do not substitute the current Global release on reads.
A missing pinned release or mismatch is an explicit unavailable/incompatible outcome, not fallback.
Publishing a new digest leaves old bytes untouched. Activation changes only the existing Global pointer with
`expectedHead` CAS; rollback reactivates an old digest and changes neither pins nor values. A release cannot prove
its relationship to another release in isolation; activation/migration admission belongs to the consumer protocol.

Any profile content change, including labels, requires a new profile revision and immutable release digest.
Removing/renaming IDs, changing roles or units, narrowing pairs, or inheritance changes additionally requires an
explicit versioned migration mapping between full source and destination pins. A label-only revision needs no
value conversion but does not rewrite existing pins. A mapping must enumerate state IDs, mode/unit pairs and
kind/status pairs it changes, and leave unmapped/unknown historic values readable under their source pin.
Unsupported new writes are rejected. No coercion, deletion or conversion from count to sparse IDs is allowed.
Migration is an explicit bounded, checkpointed consumer operation, never activation side effects.

Older releases without `library` remain valid and retain their digest. No default profile is silently installed.
Existing unprofiled rows remain legacy reads under their original release; an explicit migration can bind the
five preserved state IDs to the migration profile without changing their meaning. Unknown historic IDs remain
readable raw values under their old release; they cannot be guessed into a new state. Absence never autoenables
an adapter, creates sessions/holdings, or adds labels. New profile-aware writes require an explicit accepting pin.
The two-release package fixture proves immutable data separation and pointer rollback only; Commerce must test
actual row replay, unknown-ID reads, bounded mappings, pair narrowing and rollback through its API.

## Production handoff

1. In `src/compile.ts`, extend the class annotation allowlist and bounded source/presentation validation together;
   resolve nearest profiles at compile time and attach independently copied effective values. In `src/index.ts`
   and `schema/release.json`, add the optional closed ABI and shared semantic constraints. Keep absence valid.
2. In the five `catalogue/*.yaml` files above and their eight `presentation/<group>/*.yaml` files, add only the
   declared data. Regenerate `release/rezics.json` with the existing release script. No Commerce implementation is
   part of this slice; reconcile this proposed ABI with its manager agreement before production implementation.
3. Owners then update typed consumers and Web recordings, publish and explicitly activate. Commerce's subsequent
   acceptance owns stored pin shape adoption, migration admission, row reads/writes and observations/assertions.
   An ABI conflict must return to that agreement before implementation rather than be hidden by a compatibility alias.

`test/library-profiles.test.ts` exercises real `compileCatalogue`, `validateRelease` and `releaseDigest`; no missing
static imports manufacture red tests. `test/library-profile-expansion.test.ts` reuses the existing
`services/kernel/test/support/manifests.ts` generator and the root-import pattern from
`services/kernel/test/semantic/expansion.test.ts`. Ten and one hundred manifests each add three types and twelve
properties; only fixture work/edition get profiles through a structural base. The fixture agent does not.
Assertions charge exact canonical profile bytes plus JSON member overhead, stay within existing cardinalities,
and preserve bundled definitions/properties/contexts/filters. A fourth/sixth fixture vertical needs only source
and presentation data; no package backend code, schema/table or deployment growth per vertical. The existing
catalogue expansion acceptance is unchanged. No wall-clock performance threshold is used.
