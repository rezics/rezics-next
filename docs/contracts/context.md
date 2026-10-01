# Shared Contexts, interpretation and preferences

Shared Contexts let individuals and Realms reuse one published interpretation
without sharing speech, acceptance decisions, voters or edit authority. A Context
is an independently managed Resource; Global is the public baseline, while
"default" names a consumer's selection role. A named concept remains available
even when someone interprets the common object differently in a Context.

## Interpretations, concepts and preferences

An authored [Statement](classification.md) keeps its exact applied definitions,
semantic revision, speaker and applicability. Reading it through another Realm
or preference cannot change its meaning. A changed criterion needs a new exact
definition or statement; disagreement about evidence and preference for results
are separate acts. A public definition alone accepts no statement.

## Selection and statement meaning

The installed owner contracts are [Context schema](../../services/main/src/modules/context/schema.ts),
[selection resolution](../../services/main/src/modules/context/interpretation.ts),
[preference revision](../../services/main/src/modules/context/preferences.ts),
[Statement meaning and acceptance](../../services/main/src/modules/statement/schema.ts),
and the [CTX case inventory](../../scripts/qa/cases/classification.ts). They pin
revisions, distinguish absent/unresolved/disabled/unavailable entries, reject
equal-priority conflicts, and bound inheritance. The resolver currently supports
explicit, speaker object/relation, object and default selections, then Global.

## Shared adoption, Access and revision

- Add admitted domain selectors and disclosed entry-point defaults to the
  selection profile. Preference selection must use explicit request, saved reader
  choice, disclosed entry/Realm default, then product default; it must never
  change an explicit semantic pin or bypass content admission.
- Resolve ambiguous public terms to qualified candidates or ambiguity, never
  popularity. A hidden or missing retained dependency is unavailable, never a
  reason to select a newer or public meaning. Public statements need a readable
  semantic basis for their audience.
- Public use grants no Context edit or Realm speech. Personal selections remain
  private Access-owned pointers; Context definitions and public Realm selections
  retain their separate owners. Successor adoption needs its own guarded write.
- Keep interpretation, acceptance, rating, publication, semantic canon and
  presentation references distinct. Context or RDF named-graph membership
  confers no authority. Select compatible definitions before inference; a
  broader label cannot prove a narrower criterion.
- Declare bounded hydration, invalidation and disclosure behavior for every new
  consumer. Incomplete semantic resolution cannot authorize a write or exact
  count; capacity qualification remains the [statement workload](../storage/workload-budgets.md#statements-grouping-and-context).

These target obligations exceed the installed profile's qualified subset.
