# Access policy templates

These files are the verified Access templates for two operation families. Copy
them instead of starting a new pattern.

## Protected command write: `POST /v1/access/policy-changes`

- Owner: `policy-changes.ts` (`AccessPolicyChanges.change`), with the shared steps
  in `policy-transaction.ts`: recovery fence, principal, scope lock, mandate and grant.
- Order inside one READ COMMITTED transaction: share-lock the recovery fence,
  resolve the active principal, lock the scope gate, check the mandate and grant,
  replay or conflict on the `(principal, idempotency key)` receipt, compare the
  expected scope epoch, write the change, advance `scope_gate.authority_epoch`,
  then insert the immutable receipt. Denied, stale and replayed requests write
  nothing.
- Errors: `policy-errors.ts`; the route maps them in `routes/access-policy.ts`
  (`policyError`). Lock, timeout and serialization failures become 503.
- Tests to copy: `tests/qa/integration/access-policy-api.test.ts` (replay,
  changed-key conflict, stale epoch, denied representative, recovery hold, held
  scope lock) and the cost loop in `access-revocation-api.test.ts`.

## Authority decision: `POST /v1/access/policy-decisions`

- Evaluator: `policy-evaluator.ts` has the closed condition registry, Kleene
  three-valued logic, mandatory guards and first-applicable order. It does no
  I/O; facts are supplied by the caller.
- Owner: `policy-decisions.ts` reads every input in one REPEATABLE READ
  transaction and records the frame through `decision-snapshot-store.ts`.
  Migration 042 rejects a frame whose epochs or input generations differ from
  that snapshot, and any allow that did not pass every guard and the first
  applicable rule.
- A reusable allow is a proof handle. `POST /v1/access/policy-decision-revalidations`
  checks its bound principal, audience, actor, action and scope, then each
  recorded dependency (`requireSameInputs`). A change makes it stale; it is never
  re-derived.
- Interaction decisions (`interaction-decisions.ts`) and revocations
  (`revocation-requests.ts`) are extensions of these two templates.

## Extending

- A new condition is a registry entry in `policy-evaluator.ts`, a fact method,
  and the top-level `op` list in migration 040's `policy_rule_condition_registry`
  (added in a new migration). Record every input it reads through `FrameInputs`.
- A new decision action adds its Account scope to `POLICY_DECISION_ACTIONS`.
- A new revocation target adds a `targets` entry in `revocation-requests.ts`. The
  migration 043 schema already accepts six source kinds.

## Cost contract

With `N` unrelated Access rows, measured at 0, 32 and 256 added grants:

| Operation | Owner SQL calls | Selected rows | Written rows |
| --- | ---: | ---: | ---: |
| Decision (two guards, one grant rule) | 15 | 11 | 3 |
| Ordinary revocation | 17 | 9 | 4 |
| Publish (two guards, one rule) | 18 | 9 | 7 |

Each lookup uses a primary, unique or partial active index, so expected work is
`O(log N)` per lookup. A decision evaluates at most `R ≤ 80` rules and `S ≤ 2048`
condition states within the revision's deadline. It records at most 64 inputs and
at most 8 grant sources per `has-grant` condition. Exceeding a limit returns
`unavailable`. A strong revocation reads at most 257 admissions and 257 leases,
and drains at most 256.
