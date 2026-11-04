# Saved-query results

Ordinary saved dynamic Collections use the existing Collection address and Dynamic Collection reader. Membership
comes from the common `GET /v1/collections/{id}/members` Source; the browser does not scan the Library or invent
rows. Unique canonical subjects keep per-member Type presentation and subject links. Occurrence notes, occurrence
IDs, member counts and Collection timestamps stay omitted. The saved predicate never appears on this page.

Owner-only `RuleEditLink` opens `/collections/{id}/rule` when the signed-in viewer is the curator and the identity
is not a built-in. Authoring owns that rule editor. The owner-only `SavedQueryPublicationAction` slot, consumed by
saved-query management, opens the existing `/collections/{id}/publish` selected-members route. Built-ins, curated
identities and other viewers get no publication entry. The action is a handoff; it does not publish, and a rule
edit never auto-publishes. Public and other readers receive only already-published permitted membership. They never
receive the owner predicate or a private fact-derived evaluation. Native Collection GET concealment still hides a
private unknown identity.

## Members status

| Response                                  | Reader                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202 {preparing:true}` with `Retry-After` | Preparing. Retry the same validated URL and opaque cursor, `private, no-store`. At most three automatic retries, then an explicit reload of that same request. A failed read keeps a separate explicit retry; it never restarts polling by itself. Never treated as empty success. |
| `200 {members, next}`                     | Ready page. `members: []` and `next: null` is a genuine empty final page. A later empty page is page-local absence with first-page recovery.                                                                                                                                       |
| `503` Problem, no cursor                  | Unavailable. Distinct from empty. Retry the same address; missing execution stays unavailable.                                                                                                                                                                                     |
| `409 stale_cursor`                        | Restart once at the first page of the same Collection, filter and sort. Surface that restart and keep a first-page link that drops only the members cursor from the admitted `f.`/`r.`/`l.`/type protocol.                                                                         |

Filter and `id` sort stay on the saved rule and the current URL protocol. Changing filters drops the old cursor.
Commerce owns evaluation, admission, publication and native disclosure. This page binds Collection GET plus the
members statuses above. Remaining producer work: complete saved-source execution, explicit Publication for
public/unlisted membership, and the generated dynamic Collection DTO.

The selected-members Publication route reviews the currently disclosed owner page, confirms replacement (including
an explicit empty selection) through `publishSelected`, and inspects confirmed output. Current dynamic results stay
distinct from previously published membership. Collection GET and owner members DTOs have no published-set field, so
previous membership is unavailable until a verified complete command in this owner lifetime, and never implied as
zero members. Immutable accepted meaning on this DTO is the Collection revision plus published title and description;
release pins stay off this page. Missing publisher support stays unavailable. Public readers still see only the last
complete permitted set. Management owns metadata/delete; Commerce owns execution, immutable rule release, publication
and lifecycle. Bind `collections({id}).$publishSelected.post` when generated; an absent runtime stays unavailable.

Decision: reuse the installed Dynamic Collection reader and members GET; do not fork a second members runtime.
Decision: previously published membership is inspectable only from a verified complete `publishSelected` response in
the current owner lifetime, or from an exact complete `publication` object on the Collection DTO when Commerce adds
it. Absence is unavailable, never an empty public set.

## Recovery and rule return

Decision: returning without a rule save keeps the originating cursor; an acknowledged rule update returns to the
first page of that exact saved Collection with its supported filters, labels, layout and outer return preserved.
The old cursor belongs to the former definition and is never merged with updated membership.

The real rule route carries this bounded Collection address in `returnTo`. It accepts only the same localized saved
identity, never an external destination, credentials or another Collection. Rule GET remains a separate private
owner read. The results link requires native `collection:update` / `collection_rule.update` admission and the current
rule operation gates; the curator ID alone grants no management. Built-ins have no rule link. Successful updates
leave through a document navigation to force a fresh admitted read; creation retains its existing create-once
confirmation. Departure from an unsaved or uncertain draft uses the existing draft navigation boundary. An uncertain
command retains its original revision, key, credential and operands even after a read or an unexpected identity in
an acknowledgement.

Unavailable recovery reads immediately on explicit activation. Preparing recovery uses at most three reads per
cycle with the existing 1–30 second delay clamp; exhaustion pauses until explicit activation. A pending activation
is locked against repeated clicks. No read dispatches a command. Current ready, genuinely empty, preparing,
unsupported-filter, stale-cursor, denied and platform-closed outcomes replace the previous feedback. Denied/closed
results retire the prior shell and its controls. Thrown reads clear former members and remain explicitly retryable.
The route keeps prepared authentication and exact request provenance, including the opaque cursor and original
filter address. Native cursor rejection alone deliberately restarts the first page.

A production retry consumes the public composed page reader, replacing definition-bound filter controls, admitted
predicate, release identity, row presentation and resource actions together. Every replacement retires old bulk and
management children. Ignored or invalid predicates expose correction/reset without members or bulk authority.
Supplied property controls remain the shared Collection filter editor. Reset drops predicates deliberately; retries
never weaken them. Continued empty pages remain page-local absence. Suppressed rows do not trigger refill, counts,
identity recovery or extra requests. Native row order, duplicate destinations and source/membership fences remain
unchanged. List/grid, filter and member links carry the supported visit address through the existing shared readers.
