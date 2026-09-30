# Relation occurrence operation

`change.ts` follows the semantic command and receipt path for identified
occurrences. `schema.ts` checks each participation against one exact relation
DefinitionRef. Repeated participants in a new occurrence keep a new identity;
retirement never rewrites an older occurrence's pinned revision. The occurrence
route lives in `src/routes/relations.ts`; its shape is
`model/definitions/relation-occurrence-v1.ts`.

The lexicon's separate `definition-key-v1` component stores a unique, stable
`skos:notation`, resolved through
`GET /v1/lexicon/definitions/{key}`. Meaning and language labels remain separate.
Their optional singleton `workSubjectRole` chooses the subject of the Work edit
scope. `work-authority.ts` adapts the common occurrence command to that authority,
including a current Account assertion at claim and an unchanged subject on edit.
Access retains the occurrence action and receipt family while pinning the same
controller, grant or catalogue-role proof as a Work edit. This requires Access's
`represented_work_admission_proof` CHECK to admit those actions under `work:edit:`;
migration 972 preserves all installed branches and widens that Work editor branch.

`GET /v1/resources/{id}/relations` uses `traversal.ts`: current occurrences,
effective derivations in either direction, native author credits mapped onto the
lexicon view, and containment from selected Collection placements. It asserts no
inverse facts or additional membership relations. V2 derivations pin exact
relation-definition revisions; v1 kinds resolve through the stored registry keys.
Unresolved source versions remain explicit. Correspondence changes no reader
state or facts by itself.

The resource read withholds whole rows containing unreadable participants. A
cursor appears only after another visible row has been found, and never contains
a suppressed participant's identity. It binds the graph epoch and sequence;
concurrent graph changes or availability changes require a restart. The page
batches counterpart summaries and shares label selection per meaning/direction,
then attaches each occurrence's own bindings.

Cost contract: an occurrence admits at most 64 participations and eight
applicability references; definitions have at most 16 roles. A resource page has
at most 32 entries, 64 distinct summary references, eight indexed incidence scans
of 100 candidates, 512 graph calls, 8 MiB of graph responses and a ten-second
read deadline. These are request budgets, not catalogue-size limits. Commands and
validation footprints depend on the admitted participant bounds; exact reads
resolve one head or anchor and one retained manifest. Exceeding the visibility
scan budget yields an unavailable read, never a misleading partial page.
