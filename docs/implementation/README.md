# Implementation blueprints

These blueprints turn the owning contracts into concrete implementation shapes.
They describe the selected target, not deployed endpoints or passing prototypes.

- [Graph records and references](graph-records.md): vocabulary, shapes, history anchors and query inputs.
- [Model profiles and validation](model-profile-validation.md): standard terms, compiled shapes/rules, complete affected-state validation and guarded commands.
- [API and event surfaces](api-and-events.md): operation envelopes, service commands, errors and committed-event transport.
- [Authorization bridge](authorization-bridge.md): Main admission around Fuseki queries and publication/revocation fences.
- [Access storage decision](../research/access-storage-and-policy.md): PostgreSQL authority and coherent ordered decisions; the current rules live in the Access module.
- [Vertical workflows](vertical-workflows.md): end-to-end creation, context, source and recovery sequences.
- [Controlled installation](../../services/main/src/modules/package/install.ts): exact locks and journaled generations.
- [Interaction graph and cache bootstrap](interactions-and-cache.md): Main-owned TDB2 likes/favorites, Jena acceptance cases and later Redis read caching.

Implementation must qualify these shapes against the selected engine/profile.
An unsupported engine feature requires an explicit adapter/operator implementation
or a typed unsupported operation; examples do not imply the feature exists already.
