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

## Scope and evaluator

Decision 52, maintainer and product manager, 2026-10-04. What a claim or rating
is about and who judges it are kept in separate fields, even where they share a
dimension such as time or language. Two tests sort a field:

- **Truth condition.** If changing it changes what would make the claim true,
  or which object is rated, it is object-side: applicability, a projection
  frame or a rating target grain. It is the same in every Realm.
- **Holder swap.** Keep the claim and its scope and swap the evaluator (Global
  for a Realm, critics for audience, an authority for fans). What the two can
  disagree about (acceptance, rank, interpretation, a rating value) is
  evaluator-side: Context acceptance and definitions, a RatingContext's
  population, or the Realm that governs it.

In [McCarthy's notation](http://www-formal.stanford.edu/jmc/context3/context3.html)
a claim reads `evaluator: ist(scope, p)`: the inner context holds in-story time,
place, Work, continuity, route, release and position; the outer holds speaker,
acceptance, definitions, evidence standard and the time of assertion or
rating. [Carroll et al.](http://www2005.org/cdrom/docs/p613.pdf) separate a
graph, its warrant and a consumer's accepted set the same way, and
[Total Survey Error](https://academic.oup.com/poq/article/74/5/849/1817502)
separates what is measured from who is represented.

| Concept | Side | Record |
| --- | --- | --- |
| Narrative continuity, universe, route, edition | Object | A narrative continuity Resource; applicability; projection frames |
| A Work belongs to a continuity | Object, with evidence | A relation occurrence between the Work and the continuity; a Work may belong to several |
| Canonicity (canon, Legends, semi-canon, tiers) | Evaluator | A Statement about a source or element relative to a continuity, with authority, stance (declaration or opinion) and date; it may cover part of a source |
| Canon policy (which authorities count, what silence means, precedence) | Evaluator configuration | Definitions and acceptance rules of Global or a Realm Context |
| Fanon and headcanon | Evaluator | Statements in the same scope, accepted by a Realm or a person |
| A translated edition rated / raters who read Chinese | Object / evaluator | Release grain or frame / RatingContext population |
| Story time, edition / time asserted or rated | Object / evaluator | Frame or applicability / Statement revision or observation time |
| The reader's position and spoilers | Viewer | A display filter, neither scope nor Realm |

[Wookieepedia](https://starwars.fandom.com/wiki/Wookieepedia:Canon_policy)
shows that continuity and canonicity are independent: the six films feed both
Canon and Legends articles, and a community vote settles sources the rights
holder left unclassified. A Realm or Zone may make a continuity its default
view, as Wookieepedia opens on Canon; the choice is a labelled filter on
applicability that readers can switch, and it never rewrites a Statement's
applicability. A projection key never contains a Realm: two Realms' rating
questions can target the same projection and keep their own populations.

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
