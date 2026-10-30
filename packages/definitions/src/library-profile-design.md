# Agreed library profile ABI and implementation handoff

[Library and Collections](../../../docs/library-and-collections.md) is authoritative. This handoff incorporates the
Semantic/Commerce agreement, including unknown historical accepting types. It supersedes the original inline,
numeric-revision proposal. This change contains executable specifications and fixture data only. It neither emits
a bundle nor implements Commerce migration, activation, transactions or replay. The tests use the existing
`compileCatalogue`, `validateRelease` and `releaseDigest` entrypoints and intentionally expose missing support.

## Canonical immutable data

`Release.libraryProfiles?: Record<string, LibraryProfile>` is the sole immutable canonical registry. A registry key
must equal its object's `id`. `TypeDefinition.library?: { profileId: string }` is a closed reference, never an inline
profile. Intern each unique canonically labelled object once. Repeated identical declarations deduplicate;
conflicting semantic bodies or labels with the same ID reject. All references must resolve in the same release.
There is no numeric profile revision, second authority, mutable service or table.

Resolve the nearest whole source declaration during compilation, following the existing bounded ancestry rules.
A bridge with no declaration inherits. A nearer declaration replaces the entire profile, including absent fields
and empty lists: no field fallback, list union or runtime ancestry traversal. A declaration with only `id` is valid
and enables no state/progress/copy/import operations. A source annotation cannot be null, a scalar, an array, or an
empty object; there is no implicit suppression syntax. Older releases with neither registry nor references remain
valid, byte/digest stable, with no silently installed defaults. An optional empty registry is valid too.

The unattached `legacy-fixed-v1` entry is immutable release data, available for explicit legacy provenance only.
Source may declare it on an abstract class with no `class_uri` and no descendants. Collect that declaration as inert
annotation data; do not emit a fake type. Reject an attachment or inheritance of this reserved profile into any
accepting type. Never annotate People, Organizations, Concepts, Thing, CreativeWork or a default root to make
legacy data reachable. Ordinary writes on a type with no reference remain unsupported even when the registry has
this entry. A release without this declaration need not synthesize it; the future bundled release must include it.

## Exact closed output

All object members in this shape are exhaustive. Source uses the same nested shapes except that every `labels`
and `countForms` member is absent. Numeric strings must remain strings while parsing YAML/JSON; numeric bounds must reject without
coercion. JSON Schema, source validation and release semantic validation must agree, including recursive closure.

```ts
type Labels = { en: string } & Partial<Record<'de' | 'es' | 'fr' | 'ja' | 'ko' | 'zh-Hans' | 'zh-Hant', string>>;
type Id = string;
type Mode = 'scalar_amount' | 'cursor_position' | 'completed_units';
type LibraryProfile = {
  id: Id;
  entryStateSet?: {
    id: Id;
    states: { id: Id; labels: Labels; role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped' }[];
  };
  progress?: {
    allowed: {
      mode: Mode;
      units: {
        id: Id;
        labels: Labels;
        countForms?: Partial<
          Record<
            keyof Labels,
            { other: string; zero?: string; one?: string; two?: string; few?: string; many?: string }
          >
        >;
        dimension?: Id;
        minimum?: string;
        maximum?: string;
        precision?: number;
        totalPolicy?: 'optional' | 'required' | 'forbidden';
        identity: { kind: 'none' } | { kind: 'session_local' };
        structure: { kind: 'none' };
      }[];
    }[];
  };
  copies?: { kinds: { id: Id; labels: Labels; statuses: { id: Id; labels: Labels }[] }[] };
  importSources?: { id: Id; mappingVersion: Id; recordKinds: Id[] }[];
};
```

Use bounded ASCII data identifiers for profile/state-set/state/unit/dimension/copy-kind/status/source/mapping-version
and record-kind IDs: 1–64 characters, first `[a-z]`, remaining `[a-z0-9_.-]`. Match the entire string, including rejecting
a trailing newline (`^[a-z][a-z0-9_.-]{0,63}$` with an explicit entire-input check). This accommodates `legacy-fixed-v1`,
`legacy-unspecified`, `in_progress`, `visual-novel.reading`, `seed-tray.v2` and `v1.0`. Unit IDs and import record-kind
IDs are data, not backend enums or declarations that a provider/adapter exists. Import consumers still require an
implemented mapping for their supported record kinds; a new identifier alone enables nothing. There is no new
length cap or profile identifier grammar imposed on `acceptingType`, which is an existing real type identifier.

Labels are 1–80 Unicode code points. Exactly the eight launch locales are allowed, English is mandatory; each launch
leaf has all eight. Reject unknown locale keys, missing English, empty and oversized labels. Do not invent labels
on profiles, state sets, modes, import sources, identity or structure. Labels and semantic roles are not identifiers.

Each present state set has 1–64 states. There are 0–3 allowed modes, each with 1–32 units; 0–16 copy kinds, each with
1–64 statuses; 0–32 import sources, each with 1–16 record-kind IDs. Reject duplicate state IDs within a set, modes,
unit IDs within a mode, kind IDs, statuses within a kind, source IDs, and record kinds within a source. A unit may
appear under several modes with different metadata and labels. Status IDs may repeat in different kinds. Distinct
profiles may reuse vocabulary IDs; no global unit-name rules exist. Check missing/invalid registry references,
key/ID mismatch, hostile keys and unknown members at every nesting level, including descriptors and presentation.
Do not accept credentials, endpoints, executable configuration, conversions, grants or adapter enablement flags.

## Source and presentation homes

The annotation is a native YAML mapping, or an object in JSON schema input, never serialized JSON text in a scalar.
A minimal example in `catalogue/book.yaml` is:

```yaml
classes:
  ReadingBase:
    abstract: true
    annotations:
      library:
        id: book.reading
        entryStateSet:
          id: legacy-five
          states: [{ id: planned, role: planned }]
        progress:
          allowed:
            - mode: scalar_amount
              units:
                - id: page
                  minimum: '0'
                  maximum: '999999999999.999999'
                  totalPolicy: optional
                  identity: { kind: none }
                  structure: { kind: none }
        copies:
          kinds: [{ id: physical, statuses: [{ id: owned }] }]
        importSources: []
```

Labels live in the declaration's existing schema presentation group, for example
`presentation/book/en.yaml` under `libraryProfiles["book.reading"]`. The exhaustive leaf homes are:

```yaml
libraryProfiles:
  book.reading:
    states: { planned: Planned }
    units:
      scalar_amount: { page: page }
    copyKinds: { physical: physical }
    copyStatuses:
      physical: { owned: owned }
```

Only unit leaves additionally accept a closed `{ label: string, countForms }` object;
all other leaves remain strings. Each count-form object requires `other` and permits
`zero`, `one`, `two`, `few` and `many`, all 1–80 code points. It binds only to that
unit's locale in the optional released `countForms` map. Missing maps remain valid;
no locale's forms fall back to another locale. These are presentation metadata only,
excluded recursively from source declarations, with no effect on percent rendering,
numeric semantics, references or provenance. Launch data supplies forms for page,
chapter, episode, minute and volume; cooking currently declares minutes, and there
is no declared cooking/session count unit to invent.

`states[stateId]` labels the declared state's `labels[locale]`; `units[mode][unitId]` labels exactly that pair;
`copyKinds[kindId]` labels the kind; `copyStatuses[kindId][statusId]` labels that status in that kind. These four
optional maps are the only presentation members; maps for absent capabilities must be absent. An empty capability
may have an empty map. `units` is always mode-nested, including when only one mode is present. Thus scalar percent
and cursor percent have unambiguous independent homes. No `profile`, `stateSet` or `importSources` presentation leaf
exists. Unknown profiles, modes, units, kinds, states or statuses reject; misplaced/duplicate contributions reject.
English is required for every declared label leaf. Inheritance references the already labelled object; a child
cannot relabel it at a different home. Repeated source declarations in different schema groups may contribute only
canonically identical fully labelled objects. Conflicting labels reject just like conflicting semantic bodies.

## Progress meaning and preserved legacy acceptance

Metadata belongs to a mode/unit pair. `dimension` is optional inert vocabulary: never conversion, arithmetic or a
unit-name compatibility rule. Bounds are nonnegative exact decimal strings, using the existing parser grammar:
`0` or a nonzero-leading sequence of at most 12 integer digits, optionally followed by a dot and 1–6 fractional
digits. No signs, whitespace, exponents or leading zeros. Compare digit strings exactly, padding fractions for
comparison, rather than converting to floating point. If both bounds are present require minimum <= maximum.
Optional `precision` is an integer 0–6; absence retains the parser's 12-integer/6-fraction acceptance, including
fractional pages/counts. No implicit precision zero or integer-only count rule is permitted.

`totalPolicy` is optional/required/forbidden. Absence means the algorithm's existing default: scalar optional,
cursor and completed sets forbidden. Cursor/completed explicit policies must be forbidden. Scalar bounds apply
to amount and a supplied total. They are not a percentage conversion or a fixed total. Percent is an ordinary unit
ID; only the explicit legacy scalar percent pair sets minimum `0` and maximum `100`. Legacy cursor percent position
may exceed 100 up to the parser bounds. A normal profile's numeric bounds are its declared pair metadata.

Scalar and cursor identity is exactly `{kind:'none'}`. Completed-unit identity is exactly
`{kind:'session_local'}`. Structure is exactly `{kind:'none'}` for all three modes. No provider, revision or extra
member is accepted. Completed sets are valid personal assertions of exact opaque keys scoped to a session, not
verified episodes/achievements or an ordinal range. A reread has a new session/keyspace. Existing bounds from
`services/kernel/src/library/progress.ts` are 1–128 ASCII characters `[A-Za-z0-9_.:~-]` per sparse key, at most
100 add/remove IDs combined per command, no duplicates or add/remove overlap, and 20,000 stored completed keys per
session. Sparse `{1,3,7}` stays sparse; cardinality is separate from decimal position/amount bounds. A cursor locator
retains the existing 1–256 character bound. Package tests prove descriptors/data, not execution of these algorithms.
A future provider-backed identity/structure needs a separately implemented and agreed kernel contract.

The explicit migration profile is exactly:

- ID `legacy-fixed-v1`; state set `legacy-five`, five IDs `planned/in_progress/completed/paused/dropped`, roles
  `planned/active/completed/paused/dropped` respectively.
- All 18 pairs: `scalar_amount`, `cursor_position`, `completed_units`, each with all six IDs
  `page/chapter/episode/volume/minute/percent`. Minimum `0` on each; no precision property. Only scalar percent has
  maximum `100`; other pairs have no declared maximum beyond the existing parser or sparse cardinality bounds.
  Scalar total optional, other modes forbidden. Identity and structure as above. No global count-only restrictions.
- One kind `legacy-unspecified` with all four statuses `ordered/owned/lent/disposed`, never inferred physical/digital
  licence. Empty import sources. All state/unit/kind/status leaves have the eight launch labels.

Migration preserves actual values, IDs, revisions, dates and sparse sets and invents no session, completed range,
holding, entitlement or adapter. Unknown historical values remain readable with explicit legacy provenance.
These are Commerce obligations; definitions package fixtures do not claim that any stored row was migrated.

## Release provenance and lookup policy

```ts
type LibraryProfilePin =
  | { provenance: 'profile'; releaseDigest: string; acceptingType: string; profileId: string }
  | { provenance: 'legacy'; releaseDigest: string; acceptingType: string | null; profileId: 'legacy-fixed-v1' };
```

`releaseDigest` is the immutable `sha256:` plus 64 lowercase hex digest; there is no numeric `profileRevision`.
A normal pin requires the actual real nonnull accepting type. New writes resolve its active compiled reference
and registry entry, and cannot submit legacy provenance to bypass absent capability. Historical normal lookups
resolve the stored digest, then the stored type's reference, and verify the pinned profile ID against that reference.
An unavailable release, missing entry or mismatch is an explicit unavailable/incompatible outcome; never search
other releases, walk bases or substitute a mutable current type/release.

Legacy lookup resolves its stored digest's registry entry independently of a type annotation. A retained historical
accepting type may be used only when authoritative evidence retained it. If never retained it is `null`, never the
mutable current type, even if visible now. Never expose hidden current metadata through a migration pin. An observed
migration-time type, if separately recorded, must be identified as such and cannot replace historical provenance.
Pins are Commerce storage/API contracts; the definitions release itself contains no pins or consumer receipt data.

Publish immutable bytes, then explicitly activate through Global expected-head CAS. Bundle editing alone neither
activates databases nor migrates rows. A changed profile body or label creates a new release digest; the stable ID
may be reused in another release. Stored pins keep the old digest. Rollback to a previous digest never changes pins
or values. Narrowing/renaming/mapping changes require explicit bounded checkpointed Commerce migration admission;
never coerce or silently narrow old acceptance. Every replay authorizes at current authoritative T before receipt
disclosure. Actual migration, privacy, replay, unknown-value reads and rollback API outcomes belong to Commerce's
acceptance; the two-digest package fixture proves immutable data lookup only, not pointer transactions or row replay.

## Launch data and release cost

These are the eleven actual accepting declarations. Keep work vs edition/release distinct; unrelated agent/concept
types remain absent. Each normal profile uses `libraryProfile` in the fixture helper: five states/roles as above,
one scalar unit with minimum `0`, optional total, absent precision, identity/structure none; scalar percent maximum
`100`. Copies are physical `{owned,disposed}` and digital `{owned}` personal assertions, and imports empty.

| Source            | Class            | Accepting type   | Profile ID           | Unit    |
| ----------------- | ---------------- | ---------------- | -------------------- | ------- |
| book.yaml         | Work             | schema:Book      | book.reading         | page    |
| book.yaml         | Edition          | bf:Instance      | book.edition         | page    |
| anime.yaml        | TVSeries         | schema:TVSeries  | anime.series         | episode |
| anime.yaml        | TVSeason         | schema:TVSeason  | anime.season         | episode |
| anime.yaml        | Episode          | schema:Episode   | anime.episode        | minute  |
| anime.yaml        | Movie            | schema:Movie     | anime.film           | minute  |
| game.yaml         | VideoGame        | schema:VideoGame | game.playing         | minute  |
| game.yaml         | VideoGameRelease | wd:Q20631656     | game.release         | minute  |
| game.yaml         | GameAddOn        | wd:Q209163       | game.addon           | minute  |
| visual-novel.yaml | VisualNovel      | wd:Q689445       | visual-novel.reading | percent |
| recipe.yaml       | Recipe           | schema:Recipe    | recipe.cooking       | minute  |

Compilation touches bounded source ancestry, presentation data and each canonical registry object once, memoizing
nearest declarations. Runtime touches one type reference and one registry point, no account traversal. The complete
canonical release retains the existing limits: 4 MiB UTF-8, 1,024 types, 4,096 properties. Reject oversize bytes before
expensive semantic validation. The superseded per-inline-copy 16 KiB limit is not an additional profile cap: the
agreed 64/3x32/16x64/32x16 maxima and 80-code-point labels have an executable full-cardinality byte witness under the
actual release limit. The full-cardinality candidate with eight 80-code-point CJK labels at every label home is
2,435,593 canonical profile bytes (2,436,026 bytes in the minimal candidate release); this is byte accounting of
the proposed data, not a claim that the missing compiler/schema already accepts it. No cardinality or
complete-release limit is narrowed.

The expansion fixture uses `services/kernel/test/support/manifests.ts`: each of 10/100 manifests adds three types,
twelve properties, eight presentation files. Work/edition inherit from a structural abstract base; the agent does
not. Even manifests share one canonical profile ID; odd manifests introduce gardening `seed-tray.v2` units and
unique profiles with source/presentation only. Canonical byte delta charges each new registry key/object once and
each type's closed reference, including commas/colons/member names. Removing those members recovers the entire plain
baseline; existing bundled types, properties, contexts and filters stay equal. There is no wall-time benchmark,
per-vertical backend/table/deployment work or claim about migrated stored rows.

## Ready implementation slices

The specification is ready for these separate production slices, with no ABI alternatives left to choose:

1. **Compiler/schema:** `packages/definitions/src/compile.ts` (source annotation allowlist, inert abstract collection,
   whole-declaration inheritance, interning and presentation homes), `packages/definitions/src/index.ts` (closed ABI,
   runtime semantics), `packages/definitions/schema/release.json` (optional registry, closed references/nested data).
   Run `packages/definitions/test/library-profiles.test.ts` except the launch-data test, and expansion acceptance.
   In particular the named canonical-reference, explicit-legacy and release-pinned tests are executable reds until
   this support exists. Preserve old-release absence. No Commerce implementation is part of this slice.
2. **Catalogue/presentation/bundle:** `packages/definitions/catalogue/{book,anime,game,visual-novel,recipe}.yaml` and
   their eight `packages/definitions/presentation/<group>/<locale>.yaml` files supply the table above; put the inert
   unattached legacy declaration in `book.yaml` with its labels in the book presentation group. Regenerate
   `packages/definitions/release/rezics.json` with `bun run --cwd packages/definitions release`. Acceptance is the
   eleven-type/eight-locale launch test plus the same full package/expansion check. The future bundle change MUST
   also regenerate `apps/web/src/kernel/recorded/definitions-active.json` and `definitions-release.json` using exactly
   `bun run --cwd apps/web record -- definitions-active definitions-release` in the same change after Web's recording
   contract lands. This specification creates no bundle and does not wait for that code.
3. **Commerce:** use these structural provenance pins and lookup/absence rules; its specification owns migration,
   current authorization, privacy and actual API replay. No fake package transaction test stands in for that work.

Both real test files import only helpers/data from `test/support/library-profiles.ts`, which registers no tests.
There are no value imports between test files. The full required package command is
`bun run --cwd packages/definitions check`; root type checking is `bun scripts/typecheck.ts` and must exit zero.
