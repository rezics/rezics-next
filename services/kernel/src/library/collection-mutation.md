## Native Collection mutations

Decision: Collection creation, metadata/rule updates, publication phase changes and retained cleanup share the
Library mutation application. Contract owns Collection/history vocabulary and effect ports; core computes metadata
transitions, retention disposition and history bounds from adapter-measured statement sizes. Native adapters use the
existing SQL and caller-owned transaction. The low-level mutation facade supplies the same native application for
standalone storage callers; ordinary composition binds rule authority, publication commands and retention effects.

Decision: Collection `revision` is the shared metadata/rule/membership CAS version: each successful parent write,
including tombstone, restore and respacing writes, advances it; note-only edits do not. `order_epoch` records
respacing. Occurrence `member_revision` is a distinct row stamp; a retained member deletion records the resulting
parent version in `deletion_revision`. Access conceals a non-curator's private Collection mutation during current
admission, before receipt access. Retention timestamp bind ceilings use PostgreSQL's native
`timestamptz::text` shape; the tombstone's former 27-byte ISO declaration was two serialized JSON bytes below the
29-byte timestamp observed at the failing command. Retained cleanup remains bounded, child-first, and on its original
transaction and Pool.

`collection-command-work.ts` owns mechanical accounting and deadline helpers without importing command support.
Metadata history and retention bounds use that leaf. Episode storage no longer imports the begin-command adapter,
Source custody or builtin materialization. Rule admission uses composed Access admission, active release and owner
filter compilation. These are real dependency inversions; Source consumer migration remains a separate boundary.
Access publishes its existing command-admission and error leaves for composition; Library declares its inward
application dependency. No architecture allowance or SQL writer is added.

The owning Core command retains actor admission before receipts, exact replay, CAS, Pool, transaction, deadline,
work accounting, cancellation and unknown-COMMIT handling. The application preserves history owner/append/prune
order and immutable operands, repeated occurrence order, exact pending-output cancellation, retention expiry,
terminal obligation and Source/destination custody. It never infers Library authority from Collection access.

Fewest tests: `collection-mutation-application.test.ts` pins original transaction custody, immutable journal operands,
CAS/no-op behavior, rule and publication sequencing, and ordered retained cleanup. The composition case pins native
binding and override identity. Existing native outcome assertions remain unchanged. Workspace typing runs in the
worker. The focused suite is the landing test command; the worker wrapper defers test execution to the dev verifier.
Broader runtime acceptance runs after integration.
