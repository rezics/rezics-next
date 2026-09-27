# Structure history and revision anchors

Structure and Occurrence identities survive edits. Each revision names its
component and a complete immutable manifest; fixed selections additionally pin
target revisions. This makes exact history independent of TDB2 file generations
or replaying every earlier edit. Book adapts a Work owner to its Main Version
component; Zone, Collection and Recipe use direct owners. The profile registration
in `services/main/src/modules/structure/profiles.ts` preserves that distinction.

An edit advances one Structure head. Bounded changes copy affected immutable
pages; large replacements stage a complete generation and switch its selected
root only after projection. A restore creates a new head from retained bytes and
does not recursively restore referenced resources. The implementation lives in
`services/main/src/modules/structure/`; the shared physical mechanism is in
[revision representation](../implementation/graph-records.md#immutable-revision-representation)
and the [Jena command protocol](../storage/jena.md#transactional-command-endpoint).

Retained anchors need their manifests, pages and fixed target revisions through
movement and garbage collection. That ownership boundary is deliberate: a
missing payload cannot be replaced with the current head. The movement and
retention owners must keep this condition executable as their storage changes.
