# `@rezics/access`

## Exposure policy core

The public entry, `@rezics/access`, owns the normalized exposure contract, mounted-operation catalogue facts and the
pure combining rule used by Kernel admission, discovery and management. Its exports are limited to
`./src/index.ts`. The package has no runtime dependencies and imports no service, application, HTTP router, SQL,
clock or environment. Time, opening state, actor kind, client scope and the result of native gate authority arrive as
explicit values; the package cannot acquire authority or opening state.

Kernel's `gates/declaration.ts` adapter reads trusted mounted `x-exposure` metadata and calls
`parseExposureDeclaration`. `gates/visibility.ts` reads the single mounted operation descriptor, including its
`x-action`, then passes immutable normalized operation values to `compileExposureCatalogue`. Neither method, path,
display text nor operation ID creates permission semantics. The package compiles sorted, deduplicated groups and
stable digest entries from those facts. `decideExposure` grants exposure for a public declaration, an open group, or
a closed group when an account has the mounted client scope and Kernel's native Global gate check succeeds.
`exposureAuthorityActions` supplies only `gate:<group>` and `gate:any`; Kernel retains exact Global resource checks,
actor and authenticated-principal evidence, permission preparation, refusal and unavailable handling.

Route declarations keep `^[a-z][a-z_]{0,62}$`. Native opening and gate-action inputs keep
`^[a-z][a-z_-]{0,62}$`. Both reject `any`, `open` and `close`; these separate profiles preserve their installed
admitted sets.

## Permission policy core

Decision: Kernel derives compiled declarations from its existing action and resource-role registrations; the pure
catalogue accepts at most 1 MiB of identifier data, temporal integers are capped at 32 decimal characters, and
explanations contain fixed operand codes capped at 32 nodes and 4 KiB.

`@rezics/access` also exports `compilePolicyCatalogue`, `describeRequiredOperands`, `decidePolicy` and
`qualifyTemporalEvidence`. The compiler copies and sorts ordinary action, role and resource-type data. It rejects
malformed or duplicate declarations, unknown role actions or resource types, unresolved type roles, unsupported
profiles and catalogue inputs over their bounds before any facts are acquired. The compiled arrays and lookup records
are frozen, so mutating a registration after compilation cannot change a decision.

```ts
const compiled = compilePolicyCatalogue({ actions, roles, resourceTypes });
if (!compiled.ok) return compiled.errors;
const required = describeRequiredOperands(compiled.catalogue, request);
const decision = decidePolicy(compiled.catalogue, request, qualifiedFacts);
```

`PolicyFact` is `true`, `false` or `null`. `false` is complete negative evidence; `null` is missing or unavailable
evidence. Strong conjunction and disjunction preserve a decisive known operand without turning an unknown required
ceiling into permission. Invalid requests return `invalid`; unresolved required evidence returns `unavailable`.
Explanations use stable operand names and mark decisive operands. They carry no ACL identifiers, membership witness,
account state or grant reason.

The current data caps reuse the registered read limits: at most 100 resource types, 64 actions per type, 6,400
action/type pairs, four resource-role references per action, 25,600 role references and 1 MiB of aggregate identifier
data. A decision visits a fixed operand set. Explanations are limited to 32 nodes and 4 KiB. Temporal qualification
uses at most 2,000 half-open `[from, until)` intervals with integer-microsecond values of at most 32 decimal
characters; incomplete evidence remains unknown.

The Kernel adapter compiles the live native registrations once when it creates Access. Its receiving profiles are
every exact registered action/resource-type pair in point/page checks and `ReadDecisions`: a point infers its type
only when the action has one registered type, a page or batch supplies its exact type, and own-account actions bind
to the existing `access.account` target. The existing permission statement projects local and exact Global
primitive facts at its qualified snapshot; the core combines standing, assignment, scope, actor/principal grants,
denials and the verified public floor. Explicit advice uses the same evaluator with the floor and resource-role
grant operands excluded. A public floor is independent of scope. The exact `globalReach` bit is projected from
Kernel's registered list, and Global decisions retain command provenance; unregistered actions have no alternate
Global path. Own-account and authenticated buyer facts retain their existing native action-specific sources.

The point `Resource` has no resource-type field, so actions with no registered type or more than one target type keep
the existing native SQL evaluator. For example, resource-role registrations bind `access:grant` to
`community.realm`, `semantic.context` and `semantic.zone`; its point profile awaits a typed Resource. A batch for the
same action can use the core only when its supplied type is registered. The pure evaluation adds no query, clock
read, scan, per-row read or retry; native preparation, one bounded formula statement and each consumer's existing
disclosure checks keep their current bounds.

This package does not acquire facts, read time, verify native eligibility, mint preparation evidence, record a
governance audit or authorize a writer. Kernel still owns current identity and membership checks, the authoritative
instant and repeatable-read snapshot, deadlines, capability binding, source completeness, denial storage and audit.
The native read cost includes the existing preparation and membership/assignment reads, the one bounded formula
statement, existing before/after validity checks, and the Collection disclosure gates. The pure evaluation adds no
query, per-row read, clock read, runtime ledger or retry.

### Residual specialization

`specializePolicy(catalogue, request, qualifiedFacts, resourceOperandNames)` uses the same compiled action profile,
required-operand description and formula as `decidePolicy`. It binds known request facts and simplifies them into
closed residual data. `public.floor` is the only currently residualizable resource operand. A missing operand,
explicit `null`, malformed fact, unsupported operand or oversized result cannot become an allow. Missing and unknown
evidence retain distinct outcomes. `evaluatePolicyResidual` evaluates that data with the same strong three-valued
rules; it has no SQL vocabulary, callback slot, clock or host-code operator.

Residuals use the versioned `{ format, root }` shape and the constant, operand, not, and/or grammar. Residuals cap at
64 nodes and 4 KiB of encoded data. Explanations retain the existing 32-node and 4 KiB caps. These are package-wide
bounds; the current Collection directory specializes to either constant allow or the single `public.floor` operand.
Scalar and residual decisions share the admitted core formula, including explicit mode, denial precedence, public
floor independence from scope, missing evidence and half-open temporal qualifications.

The Collection account face uses the public-floor profile even for its owner. The curator list binds the native
full-view result before query lowering. Per-Collection management grants do not widen another account's directory.
The package receives those qualified facts as values; Kernel continues to own their snapshot, currentness and source
completeness.

## Full-call bounds

The core adds no I/O, request cache, per-row permission check or history scan. Kernel retains these fixed deployment
bounds:

| Call       | Existing full-call ceiling                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission  | One temporal opening point read; on a closed group, exact `gate:<group>` / `gate:any` checks on Global Context using the mounted action scope; `K <= 1,000`.                                      |
| Discovery  | One open-groups read and at most one gate authorization per in-scope closed group; linear in mounted `M`, with `G` and `M` fixed by deployment.                                                   |
| Management | One captured immutable deployment catalogue; keyset pages contain at most 100 groups and read each selected current opening once, with fixed native authority checks before and after disclosure. |

Opening satisfies exposure only. Route resource permission, native authority, temporal currentness and audit custody
remain with their existing Kernel owners.
