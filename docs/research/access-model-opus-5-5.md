# Access model: logical core, current fit, package and migration

Research report. It proposes, but does not change, the owner contracts in [accounts](../accounts.md),
[viewer actions](../viewer-actions.md) and the [Access README](../../services/kernel/src/access/README.md). Adoption
belongs in those documents. Source: worktree at `8180ff57d7`, read on 2026-11-04 (UTC). External sources are listed at the
end; each was retrieved during this research.

## Answer

REZICS access is a small, fixed logical model. Typed resources sit in a bounded containment tree, and temporal grants bind
roles or actions to bounded subject sets. Explicit denials override grants, and caller ceilings intersect. One decision
formula combines nine independent operands:

```text
allow = standing ∧ gate ∧ stepUp ∧ delegation ∧ ( local(x) ∨ reach(α) ∧ local⁻(Global) )
local(y) = noDeny(y) ∧ ( floor(y) ∨ ( scope ∧ actor(y) ∧ principal(y) ) )      local⁻ omits the floor
```

Decisions are three-valued: allow, deny or unavailable. The same model answers single checks, viewer-action batches and
explanations. By partial evaluation it also yields list filters that compile to SQL over a bounded neighbourhood.

**Recommendation: own a small pure core.** It would live in `packages/access` (`@rezics/access`). Do not adopt Cedar,
OpenFGA, SpiceDB or OPA as the engine. The core has no I/O and no dependencies, and it does four things:

- compile the catalogue (types, actions, roles, inheritance, floors and gates);
- plan the exact facts a decision needs;
- decide over those facts, with an operand-level explanation;
- partially evaluate list requests into a closed condition.

Conformance vectors are the cross-language specification. The kernel keeps storage and fact reads, Auth consumes the
catalogue, and web consumes typed viewer actions.

The current implementation already has most of the model's concepts and strong cost discipline. However:

- One formula is spread over SQL, TypeScript and owner callbacks.
- It hard-codes a commerce case.
- It has no containment hierarchy and no explanation.
- Its vocabulary authority is HTTP route metadata.
- Authorization is about a fifth of a 389-file folder that mainly holds accounts, identity and erasure.

Eight migration journeys move it to the core, each with a differential test against today's SQL before any cutover.

## 1. The logical model

The model is language-independent. Section 5 maps it to packages.

### 1.1 Sorts

```text
Account   a   kind ∈ {actor, organization}; state ∈ {pending, active, suspended, deleted};
              fenced: bool; floor: epoch; operator: Account | ⊥
Client    c   a registered OAuth client
Group     g   an Account of kind organization, or a Realm: anything with role-bearing membership
Resource  x   type(x) ∈ Types; parent(x): Resource | ⊥; attrs(x): name → scalar
Global        the root Resource (route 0, id 00000000-0000-8000-8000-000000000000)
Action    α   "<namespace>:<verb>"
Operation o   a mounted operation; action(o) ∈ Actions; gate(o) ∈ Groups ∪ {public}
Role      ρ   a named finite set of actions
Key       s ::= account(a) | members(g, r) | active_accounts
```

A key is a subject set, Zanzibar's userset. Groups do not contain groups. That one restriction removes the need for a
nested-group index such as Zanzibar's Leopard (section 4.1). An anonymous caller holds no key.

### 1.2 Catalogue: the only per-vertical input

```text
Types      τ ↦ { parent: τ' | ⊥, read: α, attrs: { name: scalar type } }
Actions    α ↦ { type: τ, floor: bool, reach: local | global, stepUp: (maxAge, methods) | ⊥,
                 replay: self-account-read | ⊥ }
Operations o ↦ { action: α, gate: group | public }
Roles      ρ ↦ { α … }                                closed, validated against Actions
Templates  τ ↦ { owner: ρ | ⊥, standing: [ρ] }      roles installed when a resource is created
Inherit    (τ, α) ↦ [ (k, β) ]   α on x also holds when β holds on the k-th ancestor of x, 1 ≤ k ≤ D
DenyFrom   (τ, α) ↦ [ (k, β) ]   a denial of β on the k-th ancestor also denies α on x
Relations  (τ, α) ↦ [ name ]     owner-declared relations that grant α (self, buyer, operator …)
Floors     (τ, α) ↦ Cond         closed condition over attrs(x) and ancestor floors
```

`Cond` is a closed grammar: comparison, `in` and existence over declared attributes, plus `and`, `or` and `not`. It reuses
the size limits of [`@rezics/filter`](../../packages/filter/README.md): 32 leaves and depth 4. D, the inheritance depth, is a
catalogue constant (proposed at most 4). The existing caps stay: 64 candidate actions and 256 operation bindings per type.

### 1.3 Facts: the only authority

Facts are temporal. Each holds over a half-open interval `[t0, t1)`, and intervals do not overlap per key.

```text
grant(x, s, α, I)          direct action grant
roleGrant(x, s, ρ, I)      role binding
deny(x, s, α, reason, I)   explicit denial; reason ∈ {resource, suspension, realm_ban}
rel(x, name, s, I)         an owner-declared relation, read by one exact-key statement
member(g, a, r, I)         role-bearing membership
assignment(p, q, a, I)     delegation request q from principal p to actor a
opening(group, I)          platform gate interval
account(a), parent(x), attrs(x) at T
```

Grants, role grants and denials attach to the protected resource. Membership lives on the group, and the membership
inverse on the actor is a bounded candidate set, never authority. This matches today's placement in
[accounts](../accounts.md) §5.

### 1.4 Request

```text
q = ⟨caller, o, x, T, Twall⟩     α = action(o)
caller ::= anonymous
         | ⟨actor a, client c, scopes S, principal p | ⊥, request q | ⊥, epoch e, authTime, amr⟩
```

T is the kernel's authoritative time. `Twall` is wall time, used only for credential comparisons
([accounts](../accounts.md) §9).

### 1.5 Derived relations

```text
keys(u, T)        = {account(u)} ∪ {members(g, r) | member(g, u, r, T)} ∪ {active_accounts | active(u, T)}
                    |keys(u, T)| ≤ M + 2, where M = 1,000 role-bearing memberships (today's cap)
anchors(x, α)     = {(x, α)} ∪ {(parent^k(x), β) | (k, β) ∈ Inherit(type(x), α)}
holds(u, α, x, T) ⇔ ∃ (y, β) ∈ anchors(x, α), s ∈ keys(u, T):
                      grant(y, s, β, T) ∨ ∃ ρ ∋ β: roleGrant(y, s, ρ, T)
                      ∨ ∃ n ∈ Relations(type(y), β): rel(y, n, s, T)
denied(u, α, x, T) ⇔ ∃ (y, β) ∈ {(x, α)} ∪ DenyFrom(type(x), α), s ∈ keys(u, T): deny(y, s, β, T)
```

### 1.6 Operands and the decision

| #   | Operand    | Definition                                                                                                                | Failure answer                         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | standing   | caller is anonymous, or `a` is an active, unfenced actor with `e ≥ floor(a)`                                              | 401                                    |
| 2   | gate       | `gate(o)` is public or open at T, or caller has `gate:<g>` or `gate:any` on Global, as actor and as principal, with α ∈ S | 403 `platform_closed`                  |
| 3   | stepUp     | α needs no step-up, or `Twall − authTime ≤ maxAge` and `amr ∩ methods ≠ ∅`                                                | 401 `insufficient_user_authentication` |
| 4   | delegation | p = ⊥, or `assignment(p, q, a, T)` holds                                                                                  | 403                                    |
| 5   | noDeny     | `¬denied(a, α, y, T)`, and also for p when present                                                                        | 403 or concealment                     |
| 6   | floor      | α admits a floor and `Floors(type(y), α)` holds on `attrs(y)` at T                                                        | (disjunct)                             |
| 7   | scope      | α ∈ S: the credential and consent ceiling, intersected with durable-initiator and assignment ceilings                     | 403                                    |
| 8   | actor      | `holds(a, α, y, T)`                                                                                                       | 403                                    |
| 9   | principal  | p = ⊥, or `holds(p, α, y, T)`                                                                                             | 403                                    |

```text
local(y)  = noDeny(y) ∧ ( floor(y) ∨ ( caller ≠ anonymous ∧ scope ∧ actor(y) ∧ principal(y) ) )
allow(q)  = standing ∧ gate ∧ stepUp ∧ delegation ∧ ( local(x) ∨ (reach(α) = global ∧ local⁻(Global)) )
local⁻    = local without the floor disjunct
visible(x) = allow(⟨caller, read(type(x)), x, T⟩)
```

The structure is AWS IAM's: a union inside each grant source, an intersection across ceilings, and an explicit deny that
overrides. It is also the `all / any / ceiling` algebra of [`nmnmcc/ability`](https://github.com/nmnmcc/ability), with
gate and scope as ceilings. Every request about a resource that is not `visible` answers `not_found`, explanations included.
The existing _explicit_ projection keeps the formula but restricts it: the floor is off and role grants are off
([Access README](../../services/kernel/src/access/README.md#explicit-action-decisions)). In the model, it is a parameter that
selects which relation families count.

Representation is the only principal requirement the current formula does not cover. Today, delegation intersects actor
and principal grants (operands 8 and 9). The older contract wanted something different: exercise an Agent's rights within
explicit limits, without pooling the actor's own rights
(older REZICS repository `rezics/rezics` at `95167ceab`, `docs/contracts/identity-and-access.md`, "Representation and
request evaluation"). The model can express that as a represented mode, in which `keys(Agent)` restricted by limits L replaces
`keys(a)` in operand 8. Whether to add it is an owner decision. The bounds are unchanged.

### 1.7 Three-valued evaluation and combining

Each fact read returns rows, returns none, or fails (deadline, pool, connection, retry exhaustion). Operands take values in
{T, F, U} and combine with strong Kleene connectives. The final value maps to allow, deny or unavailable.

- **Missing evidence denies.** The world is closed: an unknown action, an absent adapter or an absent fact is F.
- **Unavailability is U.** The answer is HTTP 503, never shown as "not allowed" and never cached.
- **Only a known false conjunct denies.** A deny needs a conjunct that is F on facts actually read. An unrelated failure
  never becomes a denial, and a failure never becomes an allow.

This is XACML's Permit/Deny/Indeterminate without NotApplicable, because default deny makes NotApplicable a denial at the
top. It deliberately differs from Cedar, where "a policy that errors is skipped". If that policy is a `forbid`, a missing
fact turns into a permit ([Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html)).

### 1.8 Explanation

```text
explain(q) = ⟨outcome, [operand ↦ (value, witness)]⟩
witness: grant or role-grant row (anchor y, key s, relation, transaction id) | deny row (y, s, β, reason)
         | gate group | step-up requirement | missing scope α | unavailable dependency
```

The formula is a fixed conjunction and disjunction, so the operand vector is already a complete explanation. No
minimal-core search is needed. There are two projections:

- **Audit:** the full vector with witness IDs, recorded with the command transaction. It generalises today's
  `access.governance_reach` row.
- **Viewer:** one reason code, taken from the first false operand in the table's order:
  `sign_in_required`, `platform_closed`, `step_up_required{maxAge, methods}`, `delegation_invalid`, `blocked{realm_ban}`,
  `client_scope_missing{α}` and `not_permitted`.
  - `resource` and `suspension` denials collapse to `not_permitted`.
  - It reveals no grant IDs, no other accounts and no group the viewer cannot read.
  - A non-visible resource yields only `not_found`.

### 1.9 Batch decisions (viewer actions)

```text
decideMany(caller, refs = [(τ_i, x_i)]_{i ≤ N}, ops: τ ↦ [o]) → x_i ↦ { (α, [o]) | allow(⟨caller, o, x_i, T⟩) }
```

Caller-level operands (1–4 and 7) are computed once per batch: per operation for gate and scope, per action for step-up.
Keys are prepared once. Facts are planned per type in one read. An action entry appears when the action is allowed for at
least one of its operations, and it lists exactly the allowed operations, so the gate stays per operation as
[viewer actions](../viewer-actions.md) requires.

### 1.10 Partial evaluation into data filters

The input is a partial request `⟨caller, o, τ, within y⟩`: list resources of type τ under the anchor y, which sits j levels
above τ.

1. Evaluate the caller-level operands. If any is F, the residual is `FALSE` and nothing is scanned. If any is U, the
   result is unavailable.
2. Prepare `K = keys(caller)`.
3. For inheritance anchors at or above y (k ≥ j), decide `holds` and `denied` once. They become constants.
4. For anchors below y (k < j, including x itself), emit atoms `HasRel(path_k, K, β)` and `HasDeny(path_k, K, β)`.
5. Inline the floor condition on `attrs(x)` and on ancestors below y.
6. Simplify. The residual is a closed AST:

```text
R ::= TRUE | FALSE | Attr(path, op, value) | HasRel(path, keys, relations) | HasDeny(path, keys, actions)
    | and(R…) | or(R…) | not(R)
```

The SQL adapter folds `Attr` into column predicates. `HasRel` and `HasDeny` become `EXISTS` probes over exact keys, using
the latest-interval seek in `permission-check.sql`, so history rows are never enumerated. Each list endpoint declares a
plan, and composition rejects a residual that has no admissible plan:

| Plan | Residual shape                                            | Execution                                             | Bound               |
| ---- | --------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| P0   | `TRUE`                                                    | keyset scan under y                                   | O(L) rows           |
| P1   | `Attr` only, covered by a declared partial index          | keyset scan on that index                             | O(L) rows           |
| P2   | contains `HasRel` or `HasDeny`                            | keyset scan under y, at most E examined rows per page | O(E · probes) seeks |
| P3   | `HasRel` only, no floor, grant index by subject and scope | enumerate from K by merging per-key ranges            | O(\|K\| · L) seeks  |
| –    | `FALSE`                                                   | none                                                  | 0                   |

P2 returns short or empty pages with a continuation cursor, which [AIP-158](https://google.aip.dev/158) allows ("may
return fewer results than the number requested (including zero results)"). P3 excludes the `active_accounts` key, which
matches every resource. That disjunct must be a type-level or attribute rule (P0 or P1). These plans are the bounded
counterpart of the options that [SpiceDB](https://authzed.com/docs/spicedb/modeling/protecting-a-list-endpoint) and
[OpenFGA](https://openfga.dev/docs/interacting/search-with-permissions) document:

- SpiceDB: LookupResources then a query; check-and-loop; or Materialize.
- OpenFGA: search then check; a local index; or ListObjects then search.

The residual also answers a coverage question, `ability`'s `coverage`: whether every value under y is allowed. An interface
can use it to show a "create here" control without a resource ID. Creation authorizes on the existing parent
([accounts](../accounts.md) §4).

### 1.11 Consistency and time

- One authoritative T per request and per command attempt. Facts are read at T inside a `REPEATABLE READ` snapshot per
  database ([architecture](../architecture.md#data-access)).
- Commands decide again inside their own transaction at their own T. Grants are written in the protected resource's
  transaction, or behind an Access-first barrier. A write therefore never relies on stale authorization. This is the
  guarantee that zookies provide in Zanzibar, obtained because authority and data share a partition.
- Batched reads across databases align validity at T. They do not form a distributed snapshot, which is already the
  documented [viewer-action](../viewer-actions.md) position.
- Decisions are never reused across requests.

### 1.12 Complexity bounds

Symbols:

- D: inheritance hops (≤ 4), plus Global.
- m ≤ M = 1,000: actual memberships.
- `|K| ≤ 2(m + 2)`: actor plus principal.
- r_α: roles containing α. The catalogue maximum today is 4, for `access:grant`.
- N ≤ 100: references.
- H: resource types in a batch.
- A_τ ≤ 64: actions per type; R_τ: roles defined for the type.
- G: grant rows.
- L: page size.
- E: examined-row cap.

| Operation               | Statements                                                                            | Index seeks (each O(log G))                                                  | Independent of                               |
| ----------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Single decision         | ≤ 7: time, inverse, assignment, ≤ 2 membership proofs, 1 fact slice, 1 attribute read | (D + 2) · \|K\| · (1 + r_α) grant probes, plus (D + 2) · \|K\| denial probes | other resources, other grants, grant history |
| Batch of N over H types | ≤ 5 + 2H                                                                              | N · (D + 2) · \|K\| · (A_τ + R_τ)                                            | same                                         |
| Residual compilation    | 0 (pure)                                                                              | none; residual size ≤ 2(D + 1) atoms + \|Cond\|                              | data                                         |
| Filtered list page      | per plan (section 1.10)                                                               | ≤ E · (D + 1) · \|K\| · (1 + r_α)                                            | rows outside the examined window             |
| Catalogue compilation   | 0 (pure, once at composition)                                                         | O(\|Types\| · \|Actions\| · D)                                               | data                                         |

In practice the probed keys shrink to the groups that can occur under the batch's anchors. That is today's
"resource-matched" restriction.

The batch row reduces statements from today's A·H formula pages ([viewer actions](../viewer-actions.md), Cost) to H fact
reads, at the same seek order. It does so only if the fact read keeps exact-key, latest-interval seeks. A prefix scan of
`(resource, subject)` would enumerate grant history, which grows with churn. The planner therefore emits exact keys, not
prefixes.

### 1.13 Outside the model

These stay in their owning modules. They consume decisions, or supply facts:

- authentication protocol, credentials and token issuance (Auth);
- domain validation and state transitions (commands);
- idempotency receipts: the model only exposes the `replay` attribute;
- write rate limits;
- erasure;
- workflow approval storage: approvals bind a recorded decision and recheck it at their own T;
- durable-initiator capture: restoration re-runs `decide` with the captured caller and the original ceiling intersected
  with current scopes.

## 2. Requirements fit

| Requirement                        | Place in the model                                                                                              | Current status                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Private AuthPrincipals             | caller actor `a`; `keys(a)`                                                                                     | present                                                                                                                                     |
| Public Agents, including automated | the same Account; automation is `operator(a)`; operators manage through a relation that grants `account:manage` | present (`operator.ts`)                                                                                                                     |
| Organizations                      | `Group`; `members(g, r)` keys; never a caller                                                                   | present                                                                                                                                     |
| Representation within limits       | operands 4 and 9 (delegation as intersection); optional represented mode replaces `keys(a)`                     | intersection only; non-pooling representation from the legacy contract not implemented                                                      |
| Suspended and revoked callers      | operand 1 (401), and `deny` with reason `suspension`                                                            | present                                                                                                                                     |
| Anonymous viewers                  | no keys; operand 6 only                                                                                         | present                                                                                                                                     |
| Roles as permission sets           | `Roles`                                                                                                         | present (`resource-roles.json`, `platform-governance.json`)                                                                                 |
| Bindings to scopes in a hierarchy  | `roleGrant` on y plus `Inherit` over `parent`                                                                   | **absent**: exact resource or Global only; containers handled in module code                                                                |
| Explicit denials                   | `deny`, `DenyFrom`, deny overrides                                                                              | exact resource only; Realm bans applied to content in module code                                                                           |
| Permission ceilings                | operand 7 (scope ∩ consent ∩ durable ceiling)                                                                   | present, but the scope check runs in TypeScript, outside the SQL formula                                                                    |
| Step-up                            | operand 3 from action metadata                                                                                  | partial: own-human credential effects only ([accounts](../accounts.md) §3)                                                                  |
| Platform exposure                  | operand 2 per operation                                                                                         | present (`gates/`)                                                                                                                          |
| Viewer actions                     | `decideMany`                                                                                                    | present; allow-only; A·H statements                                                                                                         |
| Data filtering                     | residual plus plans P0–P3                                                                                       | **absent**: search-then-check and pages of ≤ 200 IDs                                                                                        |
| Explanation                        | operand vector, viewer and audit projections                                                                    | **absent**: "No denial reasons or grant provenance are returned" ([viewer actions](../viewer-actions.md))                                   |
| One shared formula                 | one package; SQL generated from the residual AST; shared vectors                                                | split across SQL, TypeScript and callbacks; web re-implements matching                                                                      |
| Each operand denies independently  | one vector family per operand (section 5.4)                                                                     | actor, consent and principal covered in [`permission-outcomes.test.ts`](../../specs/permission-outcomes.test.ts); others in separate suites |
| New verticals as configuration     | `Types`, `Actions`, `Roles`, `Templates`, `Inherit`, `Floors`, `Operations`                                     | roles and templates are data; floors, containers and the action vocabulary are code or route metadata                                       |

## 3. The current implementation, measured against the model

### 3.1 Concepts present and where they live

The current design is closer to the model than its size suggests. Its temporal grant rows use `WITHOUT OVERLAPS` and
exact-key latest-interval seeks. It caps membership at 1,000 and fails closed. It carries 63 growth tests, and every
operation has a documented cost. These are the right foundations. The issue is how the formula is distributed and coupled.

| Model element                      | Current location                                                                                                                                                                                                                                                  | Coupling                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Grant, role-grant and denial facts | `access.resource_grant`, `access.resource_role_grant`, `access.resource_denial` (`services/kernel/db/access/schema.sql:4130–4184`); subject kinds limited by CHECK to `identity` and `active_accounts`, roles to `''`, `owner`, `member`                          | SQL schema is the definition                         |
| Operands 4–9                       | [`permission-check.sql`](../../services/kernel/src/access/permission-check.sql) (150 lines)                                                                                                                                                                       | the commerce rule is inline (below)                  |
| Operand 7 (scope)                  | [`permission.ts:357–360`](../../services/kernel/src/access/permission.ts), outside the SQL                                                                                                                                                                        | one formula in two languages                         |
| Operand 6 (floor)                  | opaque `prepare`/`verify` callbacks in [`eligibility.ts`](../../services/kernel/src/access/eligibility.ts)                                                                                                                                                        | code, not data; owners re-implement container chains |
| Operand 2 (gate)                   | [`gates/admission.ts`](../../services/kernel/src/access/gates/admission.ts), [`gates/catalogue.ts`](../../services/kernel/src/access/gates/catalogue.ts)                                                                                                          | separate path, same formula for `gate:*`             |
| Operand 1 (standing)               | [`authenticate.ts`](../../services/kernel/src/access/authenticate.ts), [`command-admission.ts`](../../services/kernel/src/access/command-admission.ts)                                                                                                            | correct split (authentication)                       |
| Action vocabulary                  | route metadata `x-action`, `x-resource-types`, `x-authority-*`, `x-exposure` ([`http/request.ts:255`](../../services/kernel/src/http/request.ts)); `ActionMetadata` in [`request/access.ts:77–85`](../../services/kernel/src/request/access.ts)                   | the HTTP layer is the vocabulary authority           |
| Roles and templates                | [`resource-roles.json`](../../services/kernel/src/access/resource-roles.json) (24 roles, 15 types, 72 role-action pairs), [`platform-governance.json`](../../services/kernel/src/access/platform-governance.json) (42 actions)                                    | data (good)                                          |
| Keys and membership                | [`membership-inverse.ts`](../../services/kernel/src/access/membership-inverse.ts), [`permission-inverse.sql`](../../services/kernel/src/access/permission-inverse.sql), [`permission-membership.sql`](../../services/kernel/src/access/permission-membership.sql) | bounded (good)                                       |
| Global reach                       | [`governance-reach.ts`](../../services/kernel/src/access/governance-reach.ts)                                                                                                                                                                                     | data plus SQL branch                                 |
| Batch decisions                    | [`viewer-actions.ts`](../../services/kernel/src/access/viewer-actions.ts) (imports `elysia`, `typebox`), per-module `ViewerActionResource` adapters in content, community, semantic, zones and library                                                            | HTTP and module code                                 |
| Containment                        | none in Access; [`content/viewer-actions.ts`](../../services/kernel/src/content/viewer-actions.ts) walks up to 33 reply ancestors plus board, thread, Realm and Space                                                                                             | per module                                           |
| Explanation                        | none; denials surface as `GrantDeniedError` without reasons                                                                                                                                                                                                       | –                                                    |
| Data filtering                     | candidates from projections, then `ReadDecisions.decide` on ≤ 200 IDs (for example [`community/discovery-projection-read.ts`](../../services/kernel/src/community/discovery-projection-read.ts))                                                                  | search-then-check                                    |

### 3.2 Coupling to kernel HTTP, SQL and runtime

- **A vertical inside the formula.** `permission-check.sql:62–65` hard-codes `i.action = 'edition:read'` and
  `authenticated_buyer_ids`. Through [`authenticated-benefit.ts`](../../services/kernel/src/access/authenticated-benefit.ts),
  `permission.ts` imports Commerce's `ContentEditionBenefit`, and `AccessConfig` carries
  `contentEditionBuyerFactReader` ([`request/access.ts:112–125`](../../services/kernel/src/request/access.ts)). The model
  has a slot for this: an owner-declared `buyer` relation on `content.edition`.
- **Reverse dependencies.** Access imports [`history/contracts.ts`](../../services/kernel/src/history/contracts.ts) in
  `permission.ts:19`. [`kind-audience.ts`](../../services/kernel/src/access/kind-audience.ts) imports Library and Search work
  types. Counting all files, Access imports from 16 kernel modules. Among them: request (104 imports), command (97),
  route (92), database (49), semantic (46), history (46), tokens (30), http (27), work (23) and library (10).
- **Runtime price protocol in the decision path.** 31 lines of `permission.ts` reference the `AccessWork` reservation and
  settlement ledger ([`work.ts`](../../services/kernel/src/access/work.ts), six axes). [Architecture](../architecture.md)
  rules this out: "Do not build runtime price protocols between owners".
- **Runtime trust mechanisms mixed into the formula.** These include WeakMap evidence handles (`permission.ts:174–185`),
  `AsyncLocalStorage` (`permission.ts:88`), `node:crypto` and `pg` clients. They are legitimate kernel trust tools, but
  they belong to an adapter, not to the formula.
- **Framework imports.** Nine Access files import `elysia` or `@elysia/openapi`, seven import `typebox` and 90 import `pg`. Vocabulary is compiled from mounted
  Elysia routes (`compileViewerActionBindings`, `viewer-actions.ts:65–133`).
- **Generic infrastructure owned by Access.** Kernel files import these helpers:

  | Helper                   | Defined in                 | Imports |
  | ------------------------ | -------------------------- | ------: |
  | `deadlineClient`         | `access/authenticate.ts`   |     152 |
  | `within`                 | `access/authenticate.ts`   |      76 |
  | `GrantDeniedError`       | `access/grant-commands.ts` |     119 |
  | `requireAccessDeadline`  | `access/unavailable.ts`    |      56 |
  | `AccessUnavailableError` | `access/unavailable.ts`    |      43 |

  In total, 442 kernel files outside Access import from it.

### 3.3 Duplication

- **Formula probes copied three times.** [`permission-candidates.sql`](../../services/kernel/src/access/permission-candidates.sql)
  (62 lines) and [`governance-reach-candidates.sql`](../../services/kernel/src/access/governance-reach-candidates.sql)
  (55 lines) repeat the key and probe CTEs of `permission-check.sql`.
- **Two factories.** `createAccess` exists in both [`index.ts:207`](../../services/kernel/src/access/index.ts) and
  `permission.ts:508`, joined by a `deriveAccess`/`accessRoot` adapter chain
  ([`derived-access.ts`](../../services/kernel/src/access/derived-access.ts)).
- **A second formula in a production module.** `anonymousAccess` allows `action.endsWith(':read')`
  ([`request/access.ts:448–455`](../../services/kernel/src/request/access.ts)). Tests use it.
- **Role-holder reads outside Access.** These name roles and read the role-grant table directly:
  - [`zones/resource-owner-evidence.sql`](../../services/kernel/src/zones/resource-owner-evidence.sql)
  - [`semantic/context-read-creator.sql`](../../services/kernel/src/semantic/context-read-creator.sql), which uses
    `statement_timestamp()` instead of the authoritative T
  - [`community/ban-role.sql`](../../services/kernel/src/community/ban-role.sql)

  The model needs a relation-read port, the equivalent of Zanzibar's Read API.

- **Container disclosure per module.** Thirteen files outside Access reference `ViewerActionResource` (6,591 lines in
  total, not all of it disclosure code); each owner module supplies its own container and floor logic.
- **Web matching.** `apps/web` has 16 hand-written `viewerActions.post` call sites in 15 files, and 46 copies of the
  `operations.includes(...)` match. Twenty-eight non-test files spell 68 kernel action names as string literals.
- **Prose and data disagree.** [Accounts](../accounts.md) §4 names a closed governance-reach set of five actions.
  `platform-governance.json` and the Access README list seven, adding `space:restore` and `realm:restore`.

### 3.4 What makes it 389 files

Access has 389 files and about 50,500 lines: 151 TypeScript, 232 SQL, 4 Markdown and 2 JSON. The README alone is 4,982
lines. Classified by file-name concern:

| Concern                                                                                | Files |  Lines |
| -------------------------------------------------------------------------------------- | ----: | -----: |
| Decision core: formula, grants, roles, denials, floors, creation                       |    64 |  6,835 |
| Viewer actions                                                                         |     4 |    506 |
| Platform gates                                                                         |    16 |  1,128 |
| Request plumbing: admission, evidence, deadlines, work accounting, composition, routes |    11 |  4,796 |
| Authentication bridge, sessions, barriers                                              |    29 |  3,860 |
| Account lifecycle, handles, operators, organizations, profiles, preferences            |   135 | 10,686 |
| Agent verification and identity                                                        |    37 |  6,423 |
| Erasure, retention, live copies                                                        |    34 |  6,176 |
| Durable workflows, approvals, continuations, membership work                           |    23 |  2,728 |
| Realm membership, ownership, claims                                                    |    22 |  1,486 |
| Write rate limits                                                                      |    10 |    820 |
| README, governance JSON, two SQL files                                                 |     4 |  5,074 |

The causes:

- **Access is the accounts service.** Authorization proper (decision core, viewer actions and gates) is 84 files and about
  8,500 lines, roughly a fifth.
- **One statement per SQL file.** 132 of the 232 SQL files have ten lines or fewer.
- **Dated and variant copies.** Examples are `membership-inverse-20261025093747-*.sql` (seven files),
  `realm-membership-transition-legacy-*` (seven) and `kind-audience-original.ts`.
- **Long per-feature contracts in one README.**
- **Tests.** `services/kernel/test/access/` has 325 files and about 102,000 lines; 63 are growth tests.

### 3.5 Gaps against the model

1. No containment inheritance. Owners re-implement it.
2. Floors are callbacks, not conditions. They cannot be partially evaluated, explained or tested without a database.
3. No explanation.
4. No residual. Lists rely on candidate projections and post-checks.
5. Step-up is not generic.
6. The formula has no single executable definition. It lives in SQL, `permission.ts`, `gates/`, `eligibility.ts` and the
   web matchers.
7. The vocabulary is defined by HTTP route annotations rather than by a catalogue that routes reference.

The older library (`rezics/rezics` at `95167ceab`, `libraries/access/README.md`) is a warning here. It held vocabulary and
a pure contract, and it deliberately did not "evaluate request-bound decisions": it left them to "the backend authorization
engine and the owning product surfaces". A package of names alone cannot make one formula. The shared package must own the
evaluation semantics and the vectors.

## 4. Build or adopt

### 4.1 Survey: what each system's model contributes

Every source below was retrieved during this research. Claims that rest only on search snippets are left out.

**Google Zanzibar.** [Paper](https://www.usenix.org/system/files/atc19-pang.pdf), USENIX ATC 2019.

- _Model:_ relation tuples `object#relation@user`, where a user may be a userset `object#relation`. Per-namespace
  `userset_rewrite` rules combine `_this`, `computed_userset` and `tuple_to_userset` by union, intersection and exclusion.
- _APIs:_ Check, Read, Expand, Write and Watch. There is no "list everything this user can access" API. Clients build
  their own indices from Expand and Watch, and search "often issue[s] tens to hundreds of authorization checks" per
  result set.
- _Nested groups:_ Leopard, a separate index that serves deep nesting.
- _Consistency:_ zookies solve the "new enemy" problem by ordering ACL and content writes.
- _Transfers:_ `tuple_to_userset` is the model's `Inherit`. Usersets are keys. Expand and Read are a relation-read port.
- _Does not transfer:_ zookies, because authority shares the protected resource's partition (§1.11). Leopard is avoided by
  forbidding nested groups and capping memberships.

**SpiceDB.** [Schema](https://authzed.com/docs/spicedb/concepts/schema),
[consistency](https://authzed.com/docs/spicedb/concepts/consistency),
[list endpoints](https://authzed.com/docs/spicedb/modeling/protecting-a-list-endpoint),
[datastores](https://authzed.com/docs/spicedb/concepts/datastores).

- _Model:_ `definition`, `relation` and `permission` with `+`, `&`, `-` and arrows. Caveats are CEL conditions on
  relationships.
- _APIs:_ Check, CheckBulk, LookupResources (cursored; "heavy" above about 10,000 results) and LookupSubjects.
- _Explanation:_ `--explain` traces.
- _Consistency:_ four levels, carried by ZedTokens.
- _Storage:_ PostgreSQL is recommended for self-hosted single-region use.
- _Lists:_ three options: lookup then query; check in a loop; or Materialize, available on AuthZed Dedicated.
- _Transfers:_ check traces as explanation, and its filtering options as plans P2 and P3.

**OpenFGA.** [Configuration language](https://openfga.dev/docs/configuration-language),
[configuration](https://openfga.dev/docs/getting-started/setup-openfga/configuration),
[consistency](https://openfga.dev/docs/interacting/consistency),
[search with permissions](https://openfga.dev/docs/interacting/search-with-permissions).

- _Model:_ the DSL has `or`, `and`, `but not` and `X from Y`, plus CEL conditions. Contextual tuples are limited to 100 per
  request.
- _Limits:_ `listObjectsMaxResults` defaults to 1,000 and `listObjectsDeadline` to 3 s. BatchCheck allows 50 checks.
- _Consistency:_ `MINIMIZE_LATENCY` or `HIGHER_CONSISTENCY`, with no consistency token.
- _Status:_ a CNCF Incubating project ([CNCF](https://www.cncf.io/projects/openfga/)).
- _Transfers:_ the documented search patterns. The silent-truncation limits are a warning: REZICS forbids silent
  truncation ([viewer actions](../viewer-actions.md)).

**AWS Cedar.** [Language paper](https://arxiv.org/abs/2403.04651),
[verification paper](https://arxiv.org/abs/2407.01688),
[authorization semantics](https://docs.cedarpolicy.com/auth/authorization.html),
[templates](https://docs.cedarpolicy.com/policies/templates.html),
[level validation](https://docs.cedarpolicy.com/policies/level-validation.html),
[RFC 95](https://github.com/cedar-policy/rfcs/blob/main/text/0095-type-aware-partial-evaluation.md),
[crate docs](https://docs.rs/cedar-policy/latest/cedar_policy/),
[symbolic compiler](https://docs.rs/cedar-policy-symcc),
[Lean blog](https://aws.amazon.com/blogs/opensource/lean-into-verified-software-development/),
[npm `@cedar-policy/cedar-wasm`](https://registry.npmjs.org/@cedar-policy/cedar-wasm/latest),
[BatchIsAuthorized](https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_BatchIsAuthorized.html).

- _Combining:_ default deny; `forbid` overrides `permit`. Scopes are principal, action and resource, with `when` and
  `unless` conditions.
- _Explanation:_ diagnostics return the determining policies and errors. A policy that errors is skipped.
- _Verification:_ a Lean model with proofs, plus differential random testing of the Rust code against it. An SMT symbolic
  compiler checks equivalence and subsumption.
- _Partial evaluation:_ type-aware partial evaluation exists behind the experimental `tpe` feature. RFC 95 leaves SQL to
  the application: "we can retrive the relevant resources by translating the residuals to a SQL query".
- _Entity loading:_ level validation bounds dereference depth, but the slicing loader is "not provided".
- _TypeScript:_ the WASM package is at 4.14.0.
- _Batch:_ Verified Permissions' BatchIsAuthorized takes up to 30 requests.
- _Transfers:_ validation of the catalogue against a schema, determining-policy explanation, level-bounded fact slicing,
  and differential testing of an implementation against an executable model. These are the conformance vectors of
  section 5.4.

**OPA and Rego.** [Policy language](https://www.openpolicyagent.org/docs/policy-language),
[data filtering](https://www.openpolicyagent.org/docs/filtering),
[releases](https://github.com/open-policy-agent/opa/releases),
[WASM SDK](https://github.com/open-policy-agent/npm-opa-wasm),
[project note](https://openpolicyagent.org/blog/note-from-teemu-tim-and-torin-to-the-open-policy-agent-community-2dbbfe494371).

- _Model:_ Rego is Datalog-inspired.
- _Filtering:_ partial evaluation over declared unknowns produces a SQL `WHERE`. SQL filter generation came from EOPA into
  the OPA server's Compile API in v1.9.0, according to the release notes.
- _TypeScript:_ the WASM SDK is marked "Work in Progress".
- _Status:_ OPA remains CNCF graduated. Its creators joined Apple in 2025.
- _Transfers:_ declaring unknowns, then producing a residual and then SQL.

**Oso.** [Archived library](https://github.com/osohq/oso),
[local authorization](https://www.osohq.com/docs/authorization-data/local-authorization),
[list filtering](https://www.osohq.com/docs/develop/enforce/list-filtering),
[enforcement guidance](https://www.osohq.com/academy/authorization-enforcement).

- _Status:_ the open-source Polar library is archived and no longer maintained.
- _Local authorization:_ Oso Cloud returns SQL that the application runs against its own database: `listLocal`,
  `actionsLocal` and `authorizeLocal`, for PostgreSQL and MySQL. Its own docs list the limits: no inequality between
  centralized and database data, and no recursive rules that mix the two.
- _Transfers:_ the architecture "policy plus facts in your own database plus generated SQL", and its advice against
  fetching every row and checking each. This is the shape recommended here, without the hosted service.

**CASL.** [Releases](https://github.com/stalniy/casl/releases),
[rule definition](https://raw.githubusercontent.com/stalniy/casl/master/docs-src/src/content/pages/guide/define-rules/en.md),
[`@casl/prisma`](https://raw.githubusercontent.com/stalniy/casl/master/packages/casl-prisma/README.md).

- _Model:_ per-user `can` and `cannot` rules with MongoDB-style conditions. Inverted rules are ANDed, and rule order
  matters.
- _Explanation:_ `reason` on forbidden rules.
- _Filtering:_ `accessibleBy` produces Prisma `where` clauses.
- _Status:_ 7.0 renamed `rulesToQuery` to `rulesToCondition`.
- _Transfers:_ the client idea of transporting decisions, not rules, and a `<Can>`-style helper. Per-user rule lists do
  not scale to per-resource grants.

**Casbin.** [Model syntax](https://casbin.apache.org/docs/syntax-for-models/),
[list filtering](https://casbin.apache.org/docs/list-filtering/).

- _Model:_ the PERM metamodel, with fixed policy-effect expressions; custom effects are not supported.
- _Filtering:_ "Casbin has no query planner, so the filter has to be built by the application."
- _Transfers:_ none beyond the effect vocabulary.

**XACML 3.0.** [Core specification](https://docs.oasis-open.org/xacml/3.0/errata01/os/xacml-3.0-core-spec-errata01-os-complete.html),
[Multiple Decision Profile](https://docs.oasis-open.org/xacml/3.0/multiple/v1.0/xacml-3.0-multiple-v1.0.html).

- _Combining:_ deny-overrides, permit-overrides, the ordered variants, first-applicable, only-one-applicable,
  deny-unless-permit and permit-unless-deny.
- _Decisions:_ Permit, Deny, NotApplicable and Indeterminate{D, P, DP}. Obligations and advice.
- _Architecture:_ PEP, PDP, PIP and PAP.
- _Transfers:_ Indeterminate as U, and deny-overrides. The PIP becomes the fact-slice adapter.

**Biscuit and Macaroons.** [Biscuit specification](https://github.com/eclipse-biscuit/biscuit/blob/main/SPECIFICATIONS.md),
[Macaroons paper](https://www.ndss-symposium.org/wp-content/uploads/2017/09/04_3_1.pdf).

- _Model:_ attenuable bearer capabilities. Biscuit uses Datalog checks and ordered allow and deny policies; Macaroons use
  HMAC-chained caveats with third-party discharges.
- _Transfers:_ attenuation is a ceiling (operand 7). REZICS chose short-lived tokens plus a current-state recheck instead
  of offline capabilities ([accounts](../accounts.md) §3). Capabilities would conflict with immediate revocation.

**AWS IAM.** [Evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html),
[deny and allow flow](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_policy-eval-denyallow.html),
[Zelkova](https://www.amazon.science/publications/semantic-based-automated-reasoning-for-aws-access-policies-using-smt).

- _Combining:_ implicit default deny, and explicit deny overrides. Identity and resource policies form a union; SCPs,
  RCPs, permission boundaries and session policies intersect. Zelkova reduces policies to SMT.
- _Transfers:_ the exact shape of §1.6, a union inside and an intersection across ceilings.

**OpenID AuthZEN Authorization API 1.0.** [Specification](https://openid.net/specs/authorization-api-1_0.html), Final, 11
January 2026.

- _Model:_ Subject and Resource each carry `type`, `id` and `properties`. Action has a `name`, and Context is a free object.
- _APIs:_ `/access/v1/evaluations` evaluates in batch with `execute_all`, `deny_on_first_deny` or
  `permit_on_first_permit`. `/access/v1/search/action` "returns all actions that are permitted".
- _Transfers:_ the request vocabulary of the core. `POST /v1/viewerActions` is in effect Action Search over a bounded
  batch of resources.

**Cerbos.** [API](https://docs.cerbos.dev/cerbos/latest/api/),
[conditions](https://docs.cerbos.dev/cerbos/latest/policies/conditions.html),
[repository](https://github.com/cerbos/cerbos).

- _Model:_ resource and principal policies, derived roles and CEL conditions.
- _APIs:_ CheckResources returns per-resource, per-action effects, 50 resources by default. PlanResources returns
  always-allowed, always-denied or a conditional AST, with ORM adapters.
- _Transfers:_ the three-way residual result (TRUE, FALSE or a condition), which is the residual of §1.10.

**`nmnmcc/ability`.** [Repository](https://github.com/nmnmcc/ability) and README, read in full.

- _Model:_ Schema-typed resources and principals, and plain-data conditions with a JSON codec.
  - Rule lists combine with `denyOverrides`, `permitOverrides`, `firstApplicable` or `lastApplicable`.
  - Policies compose with `all`, `any`, `firstOf` and `ceiling`.
  - A decision is `Allow`, `Deny` or `NotApplicable`.
- _Questions:_ `decide`, `explain`, `residual` and `coverage` (All, None, Some or Unknown). `Condition.fold` turns a
  residual into SQL. Paths give `under` for hierarchies.
- _Limits:_
  - `effect` 4.1 is a peer dependency, and "A 'no' goes into the error channel".
  - Policies are loaded per principal, so relationship facts must be inlined into the policy or become predicates. A
    predicate blocks both JSON encoding and query folding.
  - "The library sets no caps on paths, policy or condition trees".
- _Transfers:_ the algebra and its operation names, `coverage`, and the plain-data condition discipline. REZICS has no
  Effect dependency anywhere in `services/`, `apps/` or `packages/`.

### 4.2 Competing hypotheses

The working notes and their revisions are in `.temp/research/access-model-notes.md`.

| Hypothesis                                                                                                          | Final confidence | Decisive evidence                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ---------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 Own a small pure core (catalogue, plan, decide, residual, explain, vectors); SQL and HTTP adapters in the kernel |             0.66 | The formula is fixed and small, and per-vertical variation is data. No engine provides bounded residual-to-SQL in-process. The repository already ships pure zero-dependency packages (`@rezics/filter`, `@rezics/document`).                                                           |
| H4 Keep the kernel design; extract only the vocabulary                                                              |             0.17 | It removes the web duplication and the route-metadata authority cheaply, but leaves the formula split, the hierarchy, explanation and filtering unsolved. The older vocabulary-only library explicitly left evaluation to each consumer.                                                |
| H1 Adopt Cedar (WASM) over sliced Postgres facts                                                                    |             0.08 | Semantics fit well and verification is unmatched. But skip-on-error fails open for `forbid`. Temporal grants must be pre-filtered or encoded. Partial evaluation is experimental with no SQL. Facts go through a WASM boundary as JSON.                                                 |
| H2 Adopt OpenFGA or SpiceDB as authority and engine                                                                 |             0.03 | A second authoritative store with dual writes conflicts with grants written in the resource's single-partition transaction and with "one capability has one authority" ([architecture](../architecture.md)). ListObjects truncates by default. It is a new service under a zero budget. |
| H6 Adopt OPA with the Compile API                                                                                   |             0.03 | A server process and a general-purpose language for a fixed formula. The TypeScript path (WASM) is work in progress.                                                                                                                                                                    |
| H5 Adopt `nmnmcc/ability` as the core                                                                               |             0.03 | The right algebra, but an Effect peer dependency; relationship facts must be inlined per principal or become predicates that block JSON and SQL folding; no bounds.                                                                                                                     |

### 4.3 Recommendation and its costs

Own the core. The comparison:

- **Fit.** The REZICS formula has nine operands and a few relation families. What varies between verticals is roles,
  types, inheritance, floors and gates: catalogue data. A general policy language would add an interpreter, and the
  formula would still have to be written in it. Cedar or Rego would then hold a second copy of a formula that the SQL
  residual compiler must mirror anyway.
- **Cost.** Estimated core size, an engineering estimate rather than a measurement:
  - about 900–1,200 lines of TypeScript (catalogue compiler, planner, evaluator, residual, explanation);
  - 600–900 lines of JSON vectors;
  - a 300–400-line README.

  The kernel adapter replaces most of `permission.ts` (1,593 lines) and the three probe statements. Adopting Cedar would
  still need the fact slicer, a residual-to-SQL translator, temporal pre-filtering and a fail-closed wrapper. Those are the
  same adapters, plus a WASM dependency in kernel and Auth.

- **Lock-in.** None for the core: it is Apache-2.0, has no dependencies, and the vectors are its specification. Cedar and
  OpenFGA are open source, so their lock-in is low, but their models fix grant encoding and consistency semantics. A
  hosted engine (Oso Cloud, AuthZed Dedicated) is excluded by budget.
- **TypeScript.** The core runs unchanged in Bun (kernel, Auth) and in Cloudflare Workers (web), with no WASM.
- **SQL.** Facts are read by exact-key, latest-interval statements: the access paths of today's `permission-check.sql`,
  minus the formula. Lists use the residual AST folded to parameterized SQL.
- **Frontend.** Web never evaluates grants, because it lacks the facts. It consumes `decideMany` results through typed
  helpers and renders viewer reason codes.
- **Keep from Cedar.** Use the idea of a verified model with differential tests: the vectors plus a randomized
  differential harness against today's SQL. Optionally, a test-only Cedar encoding of the catalogue could serve as a
  second oracle. It is not needed for adoption.

## 5. Package architecture

### 5.1 The pure core: `packages/access` (`@rezics/access`)

```text
packages/access/
  package.json         Apache-2.0, version 0.x, no runtime dependencies
                       exports ".", "./viewer", "./schema/*.json", "./vectors/*"
  README.md            the normative model of section 1, with a limits table
  schema/              catalogue.json and vector.json (generated, checked like @rezics/document)
  src/
    model.ts           Caller, Request, Facts, Decision, Operand, Witness, Condition (plain JSON-compatible types)
    catalogue.ts       compileCatalogue(input) → Catalogue | CatalogueError[]
    plan.ts            plan(catalogue, request | batch) → FactPlan: exact anchor × key × action/role probes,
                       membership proofs, relation and attribute reads
    decide.ts          decide(catalogue, request, facts) → Decision
                       decideMany(catalogue, batch, facts) → BatchDecision
    residual.ts        residual(catalogue, partialRequest, facts) → Condition; coverage(...)
    condition.ts       closed Condition AST: simplify and fold(handlers)
    explain.ts         explain(decision, 'viewer' | 'audit') → reason code or witness vector
    viewer.ts          wire types and helpers: admits(result, ref, action, operation)
  vectors/             conformance vectors (section 5.4)
  test/                runs every vector; checks package purity
```

Rules, each enforced by a package test:

- No imports outside `src/`, and no `node:`, `pg`, `elysia`, `typebox` or `effect`.
- No clock reads: T and `Twall` are inputs.
- No randomness.
- Every function is total over validated input and returns a value. Unavailability is an operand value, not an exception.
- Facts carry their validity intervals, and the core re-checks containment at T. The adapter may pre-filter by T (the
  latest-interval seek); the vectors verify that the two agree.

REZICS's own catalogue goes in a separate data package, `packages/access-catalogue`:

- a private package, data only (types, actions, roles, templates, inheritance, floors, gates);
- validated by `compileCatalogue` in its check;
- holding what is now `resource-roles.json` and `platform-governance.json`, the action metadata now spread across route
  annotations, and the governance-reach list.

Kernel, Auth and web import that one package. The engine stays publishable without product data.

### 5.2 Adapters

**Kernel decision adapter** (`services/kernel/src/access/decision/`):

- _Fact reads:_ `facts.sql` executes a `FactPlan` with exact-key, latest-interval seeks, derived from the probe CTEs of
  `permission-check.sql` minus the formula. Membership inverse and proofs keep their current statements.
- _Providers:_ owner modules register declarations instead of `ViewerActionResource` code:
  - attribute and parent providers: `{ type, statement, parent, attrs }`;
  - relation providers: Commerce `buyer`, Access `self` and `operator`.
- _Evaluator:_ `evaluator.ts` implements today's `Access` ports (`prepare`, `authorize`, `authorizePage`,
  `authorizeExplicit`, `prepareReadDecisions`) over `plan` + `decide`. The kernel trust mechanisms stay in the adapter:
  opaque evidence handles, `AuthoritativeTime`, deadlines, the unavailability-to-503 mapping and governance-reach
  recording.
- _Residual SQL:_ `residual-sql.ts` folds a `Condition` into a parameterized SQL fragment for list readers, and checks the
  declared plan (P0–P3).
- _Relation reads:_ `relations.ts` provides "who holds relation R on x at T" and "does s hold R on x". It replaces the
  direct role-grant reads in `zones/`, `semantic/` and `community/`.

**HTTP adapter.**

- `POST /v1/viewerActions` becomes `decideMany` plus operation bindings.
- Bindings are still compiled from mounted routes, but each route's `x-action` and gate must reference the catalogue, so
  routes stop being the vocabulary authority.
- Command refusals add the viewer reason code to the problem response.
- Field names follow AuthZEN (`subject`, `resource`, `action.name`, `context`) where they do not change the public
  contract. Changing the contract is an owner decision.

**Auth.** Auth imports `@rezics/access-catalogue` for:

- the scope vocabulary (replacing the composition-supplied `siteActions` map);
- step-up requirements;
- admission to the `organizations` gate, through the same `decide` on Global.

**Web.**

- `@rezics/access/viewer` supplies the response type, `admits` and a `ready | unavailable` reader result.
- Typed `ActionName` and `OperationId` unions are generated from the catalogue and the published OpenAPI.
- One web loader and hook, which stay in `apps/web`, implement the refetch and identity rules of
  [viewer actions](../viewer-actions.md).
- They replace the 16 bespoke readers and 46 matchers.

### 5.3 Publishability

- The engine contains no REZICS data and no I/O. The pure packages already published from this repository follow the same
  shape: [`@rezics/filter`](../../packages/filter/package.json) and `@rezics/document` are Apache-2.0, at 0.1.0, with no
  runtime dependencies.
- The vectors and JSON Schemas let a second-language implementation conform without reading TypeScript.
- The name `@rezics/access` is unused in this repository. The older package of that name lives in a separate repository
  and is not published from here.

### 5.4 Cross-language conformance vectors

One vector is one JSON document:

```json
{
  "id": "operand.scope.missing",
  "catalogue": "base",
  "facts": {
    "accounts": [{ "id": "A", "kind": "actor", "state": "active", "fenced": false, "floor": 1 }],
    "roleGrants": [
      {
        "resource": "R",
        "key": { "account": "A" },
        "role": "library.collection.owner",
        "valid": ["2026-01-01T00:00:00Z", null]
      }
    ],
    "unavailable": []
  },
  "request": {
    "caller": { "actor": "A", "client": "C", "scopes": [], "epoch": 1 },
    "operation": "collection.update",
    "resource": { "type": "library.collection", "id": "R" },
    "at": "2026-06-01T00:00:00Z"
  },
  "expect": {
    "outcome": "deny",
    "operands": {
      "standing": true,
      "gate": true,
      "stepUp": true,
      "delegation": true,
      "noDeny": true,
      "floor": false,
      "scope": false,
      "actor": true,
      "principal": true
    },
    "viewer": { "reason": "client_scope_missing", "action": "collection:update" }
  }
}
```

Vector families:

- **Catalogue.**
  - Valid catalogues.
  - Invalid ones: a role naming an unknown action, a parent cycle, an inheritance deeper than D, a floor over an undeclared
    attribute, an invalid gate name, and over 64 actions or 256 operations per type.
- **Operands.**
  - Two base worlds: one allowed only through grants (floor false), one only through the floor (no grant, no scope).
  - Single-flip vectors that falsify exactly one operand's fact and expect a deny naming it.
    - standing, gate, stepUp, delegation and noDeny are flipped in both worlds;
    - scope, actor and principal are flipped in the grant world;
    - floor is flipped in the floor world.

    Every one of the nine operands therefore denies on its own.

  - Both-path vectors, in which floor and grant hold together and a single flip does not deny.
  - One unavailable-fact vector per fact family: it expects `unavailable` unless another operand is already false on
    facts that were read.

  This family is the executable form of the [accounts Done when](../goals/accounts.md) clause "each operand
  independently denying". `specs/permission-outcomes.test.ts` would then run it through the real kernel driver.

- **Temporal.** Inclusive start and exclusive end, plus future and expired grants and denials, at the boundaries.
- **Inheritance, deny inheritance and Global reach.** Global reach is not blocked by a local denial; that is current
  behaviour.
- **Batch.** One action backing operations whose gates differ.
- **Residual.**
  - A partial request with its normalized residual and plan class.
  - A row set with the expected filtered rows. The core evaluates it in memory; the kernel loads facts and rows into
    PostgreSQL and runs the folded SQL.
- **Explanation.** Viewer redaction, including `not_found` for a resource that is not visible.

A port in Rust, Go or SQL must pass every vector. During migration, a randomized differential harness generates small
worlds (2–4 accounts, 1–3 groups, depth ≤ 3, 1–5 grants and denials) and compares `decide` with today's
`permission-check.sql` until cutover.

## 6. Migration path

Each journey is a complete, independently landable change of 2,000–3,000 changed lines, including tests. The estimates
are engineering estimates, not measurements.

| #   | Journey                                                                                                                                                                                                                                                                                       |                             Size | Removes                                                                                                                                                                                                                             | Main risks                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Core and vectors.** Create `@rezics/access` (model, catalogue, plan, decide, explain) with operand, temporal, inheritance and batch vectors, plus a kernel test that runs the randomized differential harness against `permission-check.sql`.                                               |                      2,400–2,800 | Nothing yet. Establishes the single executable definition.                                                                                                                                                                          | Hidden behaviours: the edition buyer branch, the own-account branch, and the Global-reach bypass of local denials. Each must become a catalogue relation or a recorded owner decision before journey 3.                            |
| 2   | **Catalogue authority.** Create `@rezics/access-catalogue` from `resource-roles.json`, `platform-governance.json` and action metadata. Composition rejects a route whose `x-action` or gate is not in the catalogue. Auth reads the catalogue. Generate `ActionName` and `OperationId` types. |                      2,000–2,600 | The role compiler in `resource-roles.ts`; route annotations as vocabulary authority; Auth's `siteActions` plumbing; the five-versus-seven governance-reach drift (one data source, prose generated or checked).                     | Many mechanical route edits. Concurrent route additions during the change.                                                                                                                                                         |
| 3   | **Kernel evaluator cutover.** Run single, page and explicit decisions on `plan` + `facts.sql` + `decide`. Commerce supplies the `buyer` relation. Static bounds replace `AccessWork` reservations in the decision path.                                                                       |       2,500–3,000 (net deletion) | `permission-check.sql`, `permission-candidates.sql` and `governance-reach-candidates.sql` (267 lines); about 1,000 of `permission.ts`'s 1,593 lines; the `edition:read` special case; the commerce and history imports into Access. | Query plan regressions: gate on the existing growth tests (`growth-read-decisions`, `growth-governance-reach` and the viewer-action growth suites). Semantic drift: the cutover needs a green differential harness and vector run. |
| 4   | **Containment and floors as data; batch on `decideMany`.** Declare `parent`, `Inherit`, `DenyFrom` and `Floors` for content, community, Collection and semantic types. Owners register attribute and relation providers.                                                                      |                      2,500–3,000 | Container authority code in the content, semantic, zones, community and library viewer-action adapters; `createResourceAnonymousEligibility` callbacks for those types; the A·H formula pages (become H).                           | Content disclosure: reply ancestry stays an owner attribute (`ancestry_visible`), not authority. Realm-ban propagation must match today's outcomes in the frozen viewer-action suite.                                              |
| 5   | **Explanation and audit.** Add audit witness records for commands (generalizing `governance_reach`), viewer reason codes on refusals, and an audit explain read for governance.                                                                                                               |                      2,000–2,500 | Ad hoc denial mapping per route.                                                                                                                                                                                                    | Disclosure: redaction is covered by vectors. Whether viewer actions themselves return reasons is an owner decision; today they are allow-only.                                                                                     |
| 6   | **Web consumption.** Add `@rezics/access/viewer` and one web loader and hook. Migrate the 16 call sites and 46 matchers. Add typed operation IDs.                                                                                                                                             |                      1,800–2,400 | The bespoke readers, matchers and action string literals.                                                                                                                                                                           | Low; it runs after journey 2, in parallel with 3–5.                                                                                                                                                                                |
| 7   | **Data filtering.** Add `residual`, `coverage`, `residual-sql.ts` and plan checks. Adopt them first for Realm and Space discovery (today's search-then-check) and for Collection lists.                                                                                                       |                      2,500–3,000 | Post-check loops in those lists.                                                                                                                                                                                                    | Plan quality and sparse-page UX. Growth checks must hold examined rows constant while unrelated rows grow.                                                                                                                         |
| 8   | **Folder split (mechanical).** Move accounts, identity, verification, erasure and rate limiting out of `access/`. Move `deadlineClient`, `within`, `requireAccessDeadline`, the unavailability errors and `GrantDeniedError` to `request/`.                                                   | many touched files, little logic | The 442-importer fan-in on Access internals. Access keeps about 90 files.                                                                                                                                                           | Merge conflicts with concurrent work. Run it as an atomic codemod when the folder is quiet.                                                                                                                                        |

Ordering:

- Journey 1 must come first: nothing changes behaviour until the differential harness is green.
- Journey 2 makes every later journey cheaper, because names become types.
- Journey 3 is the only high-risk cutover, and it is reversible behind the existing `Access` ports.
- Journey 4 depends on 3. Journey 7 depends on 4, because residuals need declared containment and floors.
- If the work stops after journey 2, the result is hypothesis H4, which still removes the vocabulary duplication.

## 7. Modularization beyond access (short)

The same pattern appears in at least three other places. A cross-cutting concern has no neutral home, so it grows inside
the first domain module that needs it, and other modules then import that module's internals.

- **Runtime work accounting.** The `AccessWork` ledger in `access/work.ts` is threaded through decisions.
  Work-accounting types are referenced in 36 Library, 20 Semantic and 9 Search files. The
  [duplication audit](architecture-duplication-audit.md) ranks this first. The treatment is deletion in favour of static
  bounds and growth checks, as [architecture](../architecture.md) requires, not a package.
- **Erasure participants.** 248 files across 12 kernel modules carry erasure, retention, purge, live-copy or shared-history
  in their names: Library 94, Content 50, Access 35, Community 25, Semantic 16 and Commerce 14. The logical model is plausibly language-independent: an
  inventory of stores holding personal data, keyed to an account, with a disposition (delete, de-identify, or retain with
  reason and deadline), plus one bounded cursor engine. The access treatment (declaration package, kernel adapter, vectors)
  probably applies. Confidence is low. Comparing the state machines of three participants would settle it.
- **Request infrastructure in a domain module.** Deadline and unavailability helpers live in `access/authenticate.ts` and
  `access/unavailable.ts`, and about 150 files import them (section 3.2). The treatment is relocation to `request/`, not
  publication.

## 8. What would change this recommendation

| Evidence                                                                                                                                                      | Effect                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone or Realm owners must author arbitrary policies (not role and catalogue choices)                                                                          | Cedar becomes the right tool for that operand: a safe, analyzable, validated language. Add it as a "custom policy" operand under the core, with a fail-closed wrapper around skip-on-error. |
| Nested groups or unbounded group expansion become a product need                                                                                              | A Zanzibar engine with a Leopard-style index (SpiceDB on PostgreSQL, Materialize) becomes worth its second store. Re-examine the one-authority rule first.                                  |
| Journey 1's harness or journey 3's growth checks show that fact-slice plus in-process `decide` cannot keep `permission-check.sql`'s statement and seek bounds | Keep evaluation in SQL, but generate the formula SQL from the core's IR (a compile-to-SQL variant of H3). The vectors stay the specification.                                               |
| The owners decide containment, explanation and filtering are not wanted                                                                                       | H4 suffices: extract the catalogue and viewer types (journeys 2 and 6) and stop.                                                                                                            |
| Cedar stabilizes type-aware partial evaluation with SQL backends, and adds an error mode that denies instead of skipping                                      | H1's main gaps close. Re-evaluate it for filtering and analysis; the core's vectors become Cedar's acceptance tests.                                                                        |
| REZICS adopts Effect broadly                                                                                                                                  | Wrap the core with `nmnmcc/ability`-style Effect services as an adapter. The core itself stays dependency-free.                                                                             |
| The owner chooses non-pooling representation                                                                                                                  | Add the represented mode of §1.6. Bounds and package shape are unchanged.                                                                                                                   |

## Sources

Retrieved during this research. Items marked † were fetched directly while writing; the others were retrieved and read by
research assistants in the same session, and only their confirmed statements are used.

- Zanzibar: <https://www.usenix.org/conference/atc19/presentation/pang>, <https://www.usenix.org/system/files/atc19-pang.pdf>
- SpiceDB: <https://authzed.com/docs/spicedb/concepts/schema>, <https://authzed.com/docs/spicedb/concepts/consistency>,
  <https://authzed.com/docs/spicedb/concepts/datastores>,
  <https://authzed.com/docs/spicedb/modeling/protecting-a-list-endpoint>,
  <https://authzed.com/docs/authzed/concepts/authzed-materialize>
- OpenFGA: <https://openfga.dev/docs/configuration-language>,
  <https://openfga.dev/docs/getting-started/setup-openfga/configuration>, <https://openfga.dev/docs/interacting/consistency>,
  <https://openfga.dev/docs/interacting/search-with-permissions>, <https://www.cncf.io/projects/openfga/>
- Cedar: <https://arxiv.org/abs/2403.04651>, <https://arxiv.org/abs/2407.01688>,
  <https://docs.cedarpolicy.com/auth/authorization.html> †, <https://docs.cedarpolicy.com/policies/templates.html>,
  <https://docs.cedarpolicy.com/policies/level-validation.html>,
  <https://github.com/cedar-policy/rfcs/blob/main/text/0095-type-aware-partial-evaluation.md> †,
  <https://docs.rs/cedar-policy/latest/cedar_policy/>, <https://docs.rs/cedar-policy-symcc>,
  <https://aws.amazon.com/blogs/opensource/lean-into-verified-software-development/>,
  <https://registry.npmjs.org/@cedar-policy/cedar-wasm/latest>,
  <https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_BatchIsAuthorized.html>
- OPA: <https://www.openpolicyagent.org/docs/policy-language>, <https://www.openpolicyagent.org/docs/filtering> †,
  <https://github.com/open-policy-agent/opa/releases>, <https://github.com/open-policy-agent/npm-opa-wasm>,
  <https://openpolicyagent.org/blog/note-from-teemu-tim-and-torin-to-the-open-policy-agent-community-2dbbfe494371>
- Oso: <https://github.com/osohq/oso>, <https://www.osohq.com/docs/authorization-data/local-authorization> †,
  <https://www.osohq.com/docs/develop/enforce/list-filtering>, <https://www.osohq.com/academy/authorization-enforcement>
- CASL: <https://github.com/stalniy/casl/releases>,
  <https://raw.githubusercontent.com/stalniy/casl/master/docs-src/src/content/pages/guide/define-rules/en.md>,
  <https://raw.githubusercontent.com/stalniy/casl/master/packages/casl-prisma/README.md>
- Casbin: <https://casbin.apache.org/docs/syntax-for-models/>, <https://casbin.apache.org/docs/list-filtering/>
- XACML: <https://docs.oasis-open.org/xacml/3.0/errata01/os/xacml-3.0-core-spec-errata01-os-complete.html>,
  <https://docs.oasis-open.org/xacml/3.0/multiple/v1.0/xacml-3.0-multiple-v1.0.html>
- Capability tokens: <https://github.com/eclipse-biscuit/biscuit/blob/main/SPECIFICATIONS.md>,
  <https://www.ndss-symposium.org/wp-content/uploads/2017/09/04_3_1.pdf>
- AWS IAM: <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html>,
  <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_policy-eval-denyallow.html>,
  <https://www.amazon.science/publications/semantic-based-automated-reasoning-for-aws-access-policies-using-smt>
- AuthZEN: <https://openid.net/specs/authorization-api-1_0.html> †
- Cerbos: <https://github.com/cerbos/cerbos>, <https://docs.cerbos.dev/cerbos/latest/api/>,
  <https://docs.cerbos.dev/cerbos/latest/policies/conditions.html>
- `nmnmcc/ability`: <https://github.com/nmnmcc/ability> †,
  <https://raw.githubusercontent.com/nmnmcc/ability/main/README.md> †
- Pagination: <https://google.aip.dev/158> †
- Local sources: this worktree at `8180ff57d7`; the older REZICS repository `rezics/rezics` at `95167ceab`
  (`libraries/access`, `docs/contracts/identity-and-access.md`, `docs/contracts/connected-apps.md`).
