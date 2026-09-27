# Model, schema and index evolution

Semantic meaning, operation contracts, storage bindings, analyzers and builds
have separate versions because changing an index need not change a predicate's
meaning. Changed meaning needs a new definition or an explicit history-preserving
migration. The [model compiler](../../model/compiler/) owns semantic artifacts;
the [release manifest](../../scripts/dev/release-manifest.ts) pins the installed
combination.

## Upgrade and rollback

Prepare the new definition and conversion, retain source evidence, validate the
affected records, then activate with expected heads. Unknown values stay
explicit. Long jobs resume under fences so they cannot overwrite later edits.
PostgreSQL migrations replay forward; search builds a new generation before
switching readers. Jena shape publication alone does not migrate stored data.

Before an engine or format upgrade, retain a stopped, restorable cut with data,
metadata, keys and release manifest. Stop incompatible writers, run the fenced
conversion, verify owner coverage and fresh commands, then reopen. If an engine
format cannot be read by the old binary, rollback restores a qualified snapshot
instead of opening new files with that binary. The [format-upgrade guard](../../scripts/dev/format-upgrade.ts)
and [second-host drill](../../tests/qa/fault-recovery/second-host-format-upgrade.test.ts)
exercise the current transition.

## Editorial protection activation

The [protection contract](../contracts/editorial-protection.md#capacity-introduction-and-recovery)
requires qualified owner schemas and every admitted writer before activation.
Ambiguous old provenance cannot confer source control or human confirmation.
Hold a pre-protection restore until later protection, authority and erasure
frontiers are reconciled; reject older unchecked writer profiles.
