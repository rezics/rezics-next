# Implementation blueprints

These blueprints turn the owning contracts into concrete implementation shapes.
They describe the selected target, not deployed endpoints or passing prototypes.

- [Graph records and references](graph-records.md): vocabulary, shapes, history anchors and query inputs.
- [Model profiles and validation](model-profile-validation.md): standard terms, compiled shapes/rules, complete affected-state validation and guarded commands.
- [API and event surfaces](api-and-events.md): operation envelopes, service commands, errors and committed-event transport.
- [Authorization bridge](authorization-bridge.md): Main admission around Fuseki queries and publication/revocation fences.
- [Access implementation plan](access-control.md): PostgreSQL authority, object grants, coherent ordered decisions, Realm exclusion and the release sequence.
- [Vertical workflows](vertical-workflows.md): end-to-end creation, context, source and recovery sequences.
- [Package plans](package-plans.md): constraints, instances, locks and journaled installation.
- [Interaction graph and cache bootstrap](interactions-and-cache.md): Main-owned TDB2 likes/favorites, Jena acceptance cases and later Redis read caching.

Implementation must qualify these shapes against the selected engine/profile.
An unsupported engine feature requires an explicit adapter/operator implementation
or a typed unsupported operation; examples do not imply the feature exists already.
