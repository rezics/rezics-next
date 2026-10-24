# goal

The control plane for the rewrite's multi-agent work: tasks, attempts, routing, worker launch, gates, the merge train,
measurement records and manager event delivery. It keeps its state in a local SQLite file and does not depend on the
product database.

The design is in rezics-next-discussion `docs/tooling/` until it moves here.

```sh
bun install
bun run check   # typecheck and tests: the landing gate for this package
```
