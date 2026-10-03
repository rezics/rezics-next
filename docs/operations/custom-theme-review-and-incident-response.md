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

## Official Zone packages

The web build carries each official Zone's package in
`apps/web/zones/official/<slug>/` and runs it only while Main's presentation
read reports `execution.state: "package"` with exactly the digest of the files
that build carries. Every write below takes an operator bearer token and an
`Idempotency-Key` header equal to the body's `idempotencyKey`.

1. On the reviewed checkout, `task zones:digest -- <slug>` prints the digest.
   The slots to declare are the keys of the package's `slots` (`header`,
   `hero`, `footer`, `workCard`) plus `module:<type>` for each module slot.
2. Once per Zone, `POST /v1/themes` with a new theme UUID, the owner and the
   Zone as `hostZone`. Then `POST /v1/themes/{theme}/revisions` with
   `expectedRevision` (null for the first) and a `first-party-bundle-v1` whose
   `packageDigest` is that digest, `slots` those slots, no origins, and
   `files` the chunks `task web:build` emits for the package.
3. A reviewer on another account posts
   `POST /v1/themes/{theme}/revisions/{revision}/reviews` with
   `decision: "approved"` and the digest of the private review evidence.
4. `POST /v1/themes/{theme}/first-party-activations` with that revision, the
   current activation (null the first time) and `approvalExpiresAt`.
5. Once per Zone, `PUT /v1/zones/{zone}/configuration` with the current head
   and the presentation plus `official: { theme }`.
6. `GET /v1/zones/{zone}/presentation` reports `state: "package"` with the
   digest from step 1; `/z/<handle>` renders with `data-zone-mode="package"` and
   `/z/<handle>?safe` shows the fallback and its notice.

Any byte change in the package directory changes its digest: the Zone shows
its fallback (`digest-mismatch`) until a new revision is reviewed and activated.

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
