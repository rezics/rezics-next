# Implementation blueprints

These blueprints turn the owning contracts into concrete implementation shapes.
They describe the selected target, not deployed endpoints or passing prototypes.

- [Graph records and references](graph-records.md): vocabulary, shapes, history anchors and query inputs.
- [API and event surfaces](api-and-events.md): operation envelopes, service commands, errors and committed-event transport.
- [Authorization bridge](authorization-bridge.md): Access decisions inside Fluree queries and publication/revocation fences.
- [Vertical workflows](vertical-workflows.md): end-to-end creation, context, source and recovery sequences.
- [Package plans](package-plans.md): constraints, instances, locks and journaled installation.

Implementation must qualify these shapes against the selected engine/profile.
An unsupported engine feature requires an explicit adapter/operator implementation
or a typed unsupported operation; examples do not imply the feature exists already.
