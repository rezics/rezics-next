---
{
  "goal": "commerce",
  "manager": "commerce",
  "kind": "implementation",
  "paths": [
    "packages/client/src/kernel/**"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "criticalPath": false,
  "after": [],
  "waiting": [],
  "acceptance": {
    "command": [
      "bun",
      "run",
      "--cwd",
      "services/kernel",
      "derived"
    ],
    "tests": [
      "The ordinary generated libraryOperations POST request accepts action remove_from_library and explicit subject targets without the set_status-only required state field; a status request retains its required state.",
      "Generated preview, confirm, get, outcomes and cancel calls and authentic nullable removal receipt responses are usable through KernelClient without casts, raw HTTP or hand-edited declarations."
    ],
    "failing": true
  },
  "estimate": {
    "lines": 1100,
    "files": 24
  }
}
---

Generate the complete ordinary KernelClient declaration tree in `packages/client/src/kernel/**` with the supported
`bun run --cwd services/kernel typecheck --emit-client` command after the kernel compiler owner supplies
`discoveryConsumer` in `services/kernel/src/search/generations.ts` and `subjectConsumer` in
`services/kernel/src/search/runner.ts`. Keep the native route and schema owners unchanged here, and do not hand-edit
generated declarations or repair compiler/check infrastructure.

The request union must accept `{ action: 'remove_from_library', selection: { kind: 'explicit', targets: { subjectId:
string }[] } }` without a state, while `{ action: 'set_status', state: EntryState, selection: ... }` continues to require
state. Expose preview, confirm, get, outcomes, and cancel through `KernelClient`. Outcome receipts must include
`deletion: { deletionId: string; revision: number; restoreUntil: string } | null` and
`memberDeletion: { deletionId: string; revision: number; purgeAfter: string } | null`, with their imported native
declarations. Preserve the order reconciliation assertions in `services/kernel/scripts/client.test.ts`.

The compiler owner files and `services/kernel/db/library/schema.sql` were unchanged in the preceding increment. The
focused landing check currently reports `error: Schema dump differs from db/library/schema.sql.`; retain that owner
boundary and finish canonical acceptance after integration.
