# Relation occurrence operation

`change.ts` follows the semantic command and receipt path for identified
occurrences. `schema.ts` checks each participation against one exact relation
DefinitionRef. A repeated pair of participants in a new occurrence gets a new
identity; a definition retirement never rewrites an older occurrence's pinned
revision. The route lives in `src/routes/relations.ts` and the graph shape in
`model/definitions/relation-occurrence-v1.ts`.

The new occurrence event needs a shared relay mapping and held-graph recovery
replay before this route can be integrated.

For another relation family, copy the exact DefinitionRef resolution, role
cardinality check, expected-head command guard, occurrence revision anchor and
manifest read. Keep the family-specific authority and recovery handling in its
owner; the author-credit profile remains append-only under its Work command.

Cost contract: one occurrence admits at most 64 participations and eight
applicability references. Definition roles are at most 16. The command and
validation footprint grows with those bounds, independent of other occurrences;
current and exact reads resolve one head or anchor and one retained manifest.
The public read checks availability once for each bounded native participant.
