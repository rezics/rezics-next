# Executable theme review and incidents

## Review

1. Submit a first-party revision with the exact file manifest, host Zone,
   declared origins and byte budgets. For an official Zone, run
   `task zones:digest -- <slug>` on the reviewed checkout and put its result in
   `bundle.packageDigest`. Retain the built assets by digest.
2. Have a different reviewer inspect the source, built bytes, origin access,
   accessibility and failure behavior. Test the declarative fallback. Record
   the decision with a digest of the private review evidence.
3. Activate that reviewed revision for its host with an expiry. Changed files,
   slots, origins or Zone source bytes need a new revision and review. Confirm
   the presentation read reports `execution.state: "package"` and the exact
   `packageDigest` approved for the web build. Keep diagnostic evidence private.
   The backend does not fetch assets; verify their bytes at review and again
   when the host loads them.

## Incident

1. Revoke the affected activation; use the global execution control if the
   affected set is uncertain. Read `GET /v1/themes/execution-control`, then
   `PUT` the same path with `disabled: true`, its `expectedControl`, an operator
   acting subject and an idempotency key. Active presentation responses use
   `no-store`.
2. Record the current activation and graph receipt, preserve bounded redacted
   diagnostics, and verify that a fresh public presentation serves the fallback.
3. Revoke the unsafe activation, invalidate cached effective presentations and
   check open sessions at their next visibility or refresh point.
4. Reopen global execution only after review. The control generation fences
   all older activations, so create a fresh activation of an eligible reviewed
   revision. Use the current control head as `expectedControl` when reopening.
   Do not revive an old approval through rollback.
