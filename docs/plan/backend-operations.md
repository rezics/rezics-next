# Retained backend operation map

This map assigns every retained backend acceptance case to the owner API
operation that must carry its result. `E` means a route exists; it does not mean
the full case passes. `P` is a planned operation boundary, not a callable route
or an approved final wire contract. Reconcile its path, request/response types,
authority and cost contract with the owning capability before implementation.
Operational cases also name root procedures where service startup or physical
recovery cannot itself be an HTTP request. The [backend acceptance scope](backend-acceptance.md)
defines the 276-ID denominator and the one rendered-only exclusion.

The 2026-09-26 [Statement contract](../contracts/classification.md) replaces the
mandatory Tag/Path/Expression/Sense/Application chain. Existing classification v1
routes remain `E` only for their installed bounded behavior; new general
definition, statement, decision and aggregate work uses the planned replacement
boundaries below. Keep every retained ID and requalify migrated cases against
their actual new schemas. The active manager owns scheduling and pass status.

The shared [Context contract](../contracts/context.md) further separates reusable
semantic/preference components from Realm identity and acceptance scope. Installed
Context create and revision, Realm and personal selection, interpretation and
Statement routes below are `E`. Publish, derive, retire, general definition
lifecycle and meaning-aware aggregation remain `P` where no route exists.
Existing grants, v1 classification routes and selected old tests do not qualify
these operations. This docs-only update preserves all 276 IDs and does not resume
implementation or add a runtime pass. Re-evaluate complete-case claims against
the strengthened CTX/model/query requirements before qualification.

| Retained IDs | Owner API operation target |
| --- | --- |
| IAM01-IAM02 | E `/api/auth/*` authorization, token and session operations; E `GET /v1/me/acting-contexts`. |
| IAM03-IAM04 | E `GET /v1/me/acting-contexts`; E `POST /v1/me/acting-context-checks`. |
| IAM05 | E `GET /v1/access/group-scope`; E `POST /v1/access/group-changes`; E `POST /v1/access/group-impact-proposals`; E `GET /v1/access/group-impact-proposals/{proposalId}`; E `POST /v1/access/group-impact-approvals`; E `POST /v1/access/roles`; E `POST /v1/access/role-revisions`; E `GET /v1/access/roles/{familyId}`; E `POST /v1/access/protected-sets`; E `POST /v1/access/protected-change-proposals`; E `GET /v1/access/protected-change-proposals/{proposalId}`; E `POST /v1/access/protected-change-approvals`; E `POST /v1/access/protected-change-activations`. |
| IAM06 | E `POST /v1/me/membership-consents`, E `POST /v1/me/membership-consent-revocations` and E `POST /v1/access/membership-changes` for Agent episodes; E `POST /v1/access/grant-changes` for episode-dependent grants; E `POST /v1/me/private-membership-consents`, E `POST /v1/me/private-membership-consent-revocations`, E `POST /v1/access/private-membership-changes`, E `POST /v1/access/private-group-member-changes`, E `POST /v1/access/private-role-binding-changes` and E `GET /v1/me/private-memberships` for private-principal episodes; E `POST /v1/access/org-realm-changes` for independent Org participation. General group/role/Realm semantics remain planned. |
| IAM07 | E `POST /v1/access/revocations`; E `GET /v1/access/revocations/{revocationId}`; E `POST /v1/me/acting-context-checks`; protected command replay. |
| IAM08 | E `POST /v1/agents/control`; E `GET /v1/agents/control`; E `POST /v1/agents/controller-changes`; E `POST /v1/agents/recoveries`; E `POST /v1/access/protected-change-approvals` and E `POST /v1/access/protected-change-activations` for independent recovery approval; P `POST /v1/accounts/recoveries`. |
| IAM09 | E `/api/auth/*` consent, refresh and token introspection operations. |
| IAM10 | E `POST /v1/me/acting-context-checks`; protected command admission. |
| IAM11 | P `POST /v1/accounts/erasures`; E `GET /v1/content-revisions/{revision}`. |
| IAM12 | E `POST /v1/agents/invitations`; E `GET /v1/agents/invitations/{invitationId}`; E `POST /v1/agents/invitation-acceptances`; E `POST /v1/agents/invitation-revocations`. |
| IAM13-IAM14 | E `POST /v1/access/grant-changes`; E `POST /v1/access/delegated-grant-changes`; E `GET /v1/access/grants/{grantId}`; E `GET /v1/access/grants/{grantId}/lineage`; E `GET /v1/access/grants`. |
| IAM15-IAM17 | E `POST /v1/access/policy-decisions`; E `POST /v1/access/policy-changes`; E `GET /v1/access/policies/{policyId}/revisions/{revision}`. |
| IAM18-IAM20 | E `PUT /v1/me/interaction-mutes`; E `GET /v1/me/interaction-mutes`; E `POST /v1/access/interaction-blocks`; E `POST /v1/access/interaction-decisions`; E `POST /v1/access/policy-decisions`. |
| IAM21-IAM22 | E `GET /v1/content-revisions/{revision}`; E `POST /v1/access/policy-decisions`. |
| IAM23-IAM24 | E `POST /v1/access/org-realm-proposals`, E `POST /v1/access/org-realm-changes` and E `GET /v1/access/org-realm-participation` for independent Org/Realm participation; E `POST /v1/access/org-realm-moves` for an atomic independent-organization transfer; E `POST /v1/organization-publication-rejections` and E `POST /v1/publication-rejections` for exact Realm-local moderation; E `POST /v1/access/managed-organization-grants`, E `GET /v1/access/managed-organization-grants/{grantId}`, E `GET /v1/access/organization-management` and E `POST /v1/access/organization-roster-policy` for one explicit managed authority and protected roster operation. P broader quota/review and paid benefits. |
| IAM25-IAM27 | E `POST /v1/me/acting-context-checks`; E `POST /v1/me/representation-requests`; E `GET /v1/access/representation-requests/{requestId}`; E `POST /v1/access/representation-changes`; E `GET /v1/access/representations/{representationId}`; E `POST /v1/access/eligible-org-member-set-grant-changes`, E `GET /v1/access/eligible-org-member-set-grants/{grantId}`, E `POST /v1/access/selected-org-membership-changes` and E `GET /v1/me/selected-org-membership-changes` for IAM25's exact selected set; E `POST /v1/me/represented-org-membership-requests`, E `GET /v1/access/represented-org-membership-requests/{requestId}`, E `POST /v1/access/represented-org-mandate-changes`, E `POST /v1/access/represented-org-grant-changes` and E `POST /v1/access/represented-org-membership-changes` for IAM26; E `POST /v1/access/representation-edge-changes`, E `GET /v1/access/representation-edges/{edgeId}`, E `POST /v1/me/authority-admissions` and E `POST /v1/me/authority-admissions/{admissionId}/checks` for an admitted representation path. P wider selectors. |
| IAM28-IAM29 | E `POST /v1/me/acting-context-checks`; E `POST /v1/access/representation-edge-changes`; E `GET /v1/access/representation-edges/{edgeId}`; E `POST /v1/me/authority-admissions`; E `POST /v1/me/authority-admissions/{admissionId}/checks`; E `POST /v1/access/revocations` for one of two independent grants. P incompatible partial-path pooling. |
| IAM30-IAM32 | E `POST /v1/access/group-changes`; E `POST /v1/access/group-impact-approvals`; E `POST /v1/access/roles`; E `POST /v1/access/role-bindings`; E `POST /v1/access/protected-sets`; E `POST /v1/access/protected-change-proposals`; E `GET /v1/access/protected-change-proposals/{proposalId}`; E `POST /v1/access/protected-change-approvals`; E `POST /v1/access/protected-change-activations`; E `POST /v1/me/automation-enrollments`; E `POST /v1/access/automation-installations`; E `POST /v1/access/representative-policy-changes`; E `GET /v1/access/representative-policies/{policyId}`; E `POST /v1/access/representative-roster-changes`; E `POST /v1/access/delegated-grant-changes`. |
| IAM33-IAM36 | E `POST /v1/me/acting-context-checks`; E `PUT /v1/me/acting-context-preferences/work.create`; E `GET /v1/access/group-scope`; E `POST /v1/access/grant-changes`; E `POST /v1/access/representation-changes`; E `POST /v1/access/roles`; E `GET /v1/access/role-bindings`; E `GET /v1/access/role-bindings/{bindingId}`; E `POST /v1/access/policy-decision-revalidations`. P broader proof operations. |
| IAM37 | P `PATCH /v1/catalog/resources/{resource}/descriptions`; E `POST /v1/me/acting-context-checks`. |
| MODEL01-MODEL04 | E `POST /v1/works` with bounded `semanticTypes`; E `GET /v1/revisions/{revision}`; E `POST /v1/works/{id}/scalar-value`, E `GET /v1/works/{id}/scalar-value` and E `GET /v1/works/{id}/scalar-value/revisions/{revision}` for MODEL02's six-state Work profile; P general `POST /v1/semantic/changes` and `GET /v1/semantic/resources/{resource}/revisions/{revision}`. Huge/exact quantity and temporal/language profiles remain planned for MODEL03/04. |
| MODEL05-MODEL06 | E `POST /v1/works/{id}/source-author-credits`; E `GET /v1/works/{id}/author-credits/{credit}/revisions/{revision}`; E `GET /v1/sources/author-credit-supports/{support}` and E `POST /v1/sources/author-credit-supports/{support}/withdrawals` for one immutable external-reference credit profile. P general `POST /v1/relations/changes` and `GET /v1/relations/{occurrence}/revisions/{revision}`. |
| MODEL07 | E `GET /v1/revisions/{revision}`; P `POST /v1/owners/relocations`. |
| MODEL08-MODEL10 | E `POST /v1/works` with bounded `semanticTypes`; P `POST /v1/semantic/changes`; E `POST /v1/me/acting-context-checks`; P `POST /v1/sources/observations`. |
| MODEL11-MODEL12 | E `GET /v1/revisions/{revision}`; P `POST /v1/owners/reconciliations`. |
| MODEL13-MODEL14 | P `POST /v1/semantic/changes`; P `GET /v1/semantic/resources/{resource}`. |
| MODEL15-MODEL18 | E `POST /v1/works`; E `POST /v1/classification-propositions`; E `GET /v1/classification-propositions/{sense}`; E `GET /v1/works/{id}/title-control` and E `POST /v1/works/{id}/title-control/source-return` for MODEL17's editorial-control epoch; P `POST /v1/semantic/changes`. |
| MODEL19-MODEL21 | P `POST /v1/semantic/changes`; P `POST /v1/semantic/resolutions`. |
| MODEL22-MODEL24 | E `POST /v1/works`; P `POST /v1/semantic/changes`; P `GET /v1/model/generations/current`. |
| MODEL25-MODEL27 | E `GET /v1/revisions/{revision}`; E `POST /v1/works`; P `POST /v1/owners/reconciliations`. |
| CTX01-CTX03 | E `POST /v1/spaces`; E `GET /v1/spaces/{space}`; E earlier `POST /v1/classification-decisions`, `POST /v1/classification-resolutions`, `POST /v1/classification-contexts` and `GET /v1/realms/{realm}/classification-context`; E `POST /v1/contexts`, E `POST /v1/contexts/{id}/semantic-revisions` and E `GET /v1/contexts/{id}` for shared Context create and revision; E `POST /v1/realms/{realm}/context-selections`, E `PUT /v1/me/context-selections` and E `GET /v1/me/context-selections` for Realm and personal selection; E `POST /v1/context-interpretations`; E `POST /v1/statements`; E `GET /v1/statements/{id}`; E `POST /v1/statement-decisions` and E `POST /v1/statement-resolutions` for separate acceptance. P `POST /v1/contexts/changes` for publish, derive and retire. |
| CTX04-CTX05 | E earlier `POST /v1/classification-propositions`, E `GET /v1/classification-propositions/{sense}` and E `POST /v1/classification-resolutions`; E `POST /v1/contexts`, E `POST /v1/contexts/{id}/semantic-revisions` and E `GET /v1/contexts/{id}`; E `POST /v1/context-interpretations`; E `POST /v1/statements` and E `GET /v1/statements/{id}` for authored meaning; E `POST /v1/statement-resolutions`. P `POST /v1/semantic/changes` for exact resources and scoped definitions; P `POST /v1/contexts/changes` for publish, derive and retire. |
| CTX06-CTX07 | P `POST /v1/semantic/changes` for admitted definition/rule/name profiles; E `POST /v1/context-interpretations` for bounded unambiguous interpretation; E `POST /v1/statement-resolutions`; E earlier `POST /v1/classification-resolutions`. |
| CTX08-CTX10 | P `POST /v1/semantic/changes` for vocabulary/definition lifecycle; E `POST /v1/contexts/{id}/semantic-revisions` and E `POST /v1/realms/{realm}/context-selections` for pinned bases; P `POST /v1/contexts/changes` for retirement and successor adoption; P grouped-statement profiles at `POST /v1/queries`; E `POST /v1/statement-resolutions`. |
| WORK01-WORK02 | E `POST /v1/works`; E `POST /v1/contributions`; E `POST /v1/contribution-publications`; E `POST /v1/contribution-edits`; E `GET /v1/contributions/{contribution}/drafts/{revision}`; E `POST /v1/translation-links`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}/translation-links`; E `GET /v1/main-versions/{mainVersion}/native-variants`; E `PUT /v1/me/main-versions/{mainVersion}/variant-preference`; E `PUT /v1/realms/{realm}/main-versions/{mainVersion}/variant-recommendation`. |
| WORK03-WORK04 | E `POST /v1/publication-selections`; E `GET /v1/realms/{realm}/main-versions/{mainVersion}/selection`; E `GET /v1/main-versions/{mainVersion}/selection`; E `POST /v1/work-derivations`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}/work-derivations`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}`. |
| WORK05 | E `POST /v1/fixed-releases`; E `GET /v1/fixed-releases/{release}`; E `GET /v1/main-versions/{mainVersion}/revisions/{revision}`. |
| WORK06 | E `POST /v1/rating-observations`; E `POST /v1/rating-aggregates`. |
| WORK07 | E `POST /v1/package-resolutions`; E `POST /v1/package-locks`. |
| WORK08 | P `POST /v1/sources/observations`; E `POST /v1/sources/correspondences`; E `GET /v1/sources/correspondences/{correspondence}`. |
| WORK09-WORK10 | E `POST /v1/content-drafts`; E `POST /v1/content-publications`; E `POST /v1/contribution-publications`; E `GET /v1/content-revisions/{revision}`. |
| RATE01-RATE02 | E `POST /v1/rating-observations`; E `POST /v1/rating-aggregates`. |
| RATE03-RATE04 | E `POST /v1/rating-contexts` for the daily timezone profile, E `POST /v1/rating-observations` for server-calendar daily slots and exact-head standing/daily `value: null` withdrawal, E `GET /v1/rating-observations/{observation}/revisions/{revision}` for private exact history. Daily aggregation and broader cadence policies remain planned. |
| RATE05-RATE06 | E `POST /v1/rating-contexts`; E `GET /v1/rating-contexts/{id}`; E `POST /v1/rating-contexts/{id}/policy-revisions`; E `GET /v1/rating-contexts/{id}/policy-revisions/{revision}`; E `POST /v1/rating-aggregates`; E `POST /v1/global-rating-contexts`; E `GET /v1/global-rating-contexts/{id}`; E `POST /v1/global-rating-observations`; E `POST /v1/global-rating-aggregates`; E `POST /v1/rating-syntheses`. |
| RATE07-RATE09 | P `POST /v1/events/observations`; P `POST /v1/events/queries`. |
| GRAPH01-GRAPH02 | E `POST /v1/queries`; P `POST /v1/relations/changes`. |
| GRAPH03-GRAPH05 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| GRAPH06 | E `POST /v1/graph-layouts`; E `GET /v1/graph-layouts/{layoutId}`. |
| OPS01-OPS02 | E `GET /health/live`; E `GET /health/ready`; owner `yarn toolchain:install`, `yarn stack:up`. |
| OPS03-OPS04 | E `GET /v1/revisions/{revision}`; P `POST /v1/owners/reconciliations`; owner `yarn stack:backup`. |
| OPS05-OPS06 | E `POST /v1/queries`; E `POST /v1/works`; E `GET /v1/operations/backpressure`; owner `yarn load`, `yarn fixture:restore`. |
| OPS07-OPS08 | E `/api/auth/*` token/session operations; E `POST /v1/me/acting-context-checks`. |
| OPS09 | E `POST /v1/queries`; E `GET /health/search-ready`; owner `yarn search:rebuild`. |
| OPS10-OPS12 | E `POST /v1/erasures`; E `GET /v1/erasures/{erasureId}`; E `GET /v1/revisions/{revision}`. |
| OPS13-OPS14 | E `GET /health/live`; E `GET /health/ready`; E `GET /health/search-ready`; E `POST /v1/works`; E `POST /v1/queries`; owner `yarn stack:up`. |
| OPS15-OPS16 | E `POST /v1/queries`; E `GET /v1/search/generations/current`; E `GET /health/search-ready`; owner `yarn search:rebuild`. |
| SEARCH01-SEARCH02 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH03-SEARCH04 | E `POST /v1/queries`; E `POST /v1/private-queries`. |
| SEARCH05-SEARCH06 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH07-SEARCH08 | E `POST /v1/works`; E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH09-SEARCH10 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH11-SEARCH12 | E `POST /v1/private-queries`; E `POST /v1/me/acting-context-checks`. |
| SEARCH13-SEARCH14 | E `POST /v1/queries`; P `POST /v1/semantic/changes`. |
| SEARCH15-SEARCH17 | E `POST /v1/queries`; owner `yarn search:rebuild`. |
| SEARCH18-SEARCH20 | E `POST /v1/queries`; E `POST /v1/content-search-eligibility`; owner `yarn search:rebuild`, `yarn load`. |
| SUB01-SUB03 | E `POST /v1/subscriptions/quotes`; E `POST /v1/subscriptions/changes`; E `POST /v1/subscriptions/gifts`; E `POST /v1/subscriptions/settlements`; E `GET /v1/subscriptions/{subscriptionId}`; E `GET /v1/subscriptions/benefits`. |
| SUB04-SUB06 | E `POST /v1/realms/{realm}/quota-reservations`; E `GET /v1/realms/{realm}/quota-reservations`; P `POST /v1/realms/{realm}/review-decisions`; P `POST /v1/realms/{realm}/replies`. |
| SUB07-SUB08 | E `POST /v1/pro-sites/queries`; E `POST /v1/subscriptions/reconciliations`. |
| HUB01-HUB02 | P `POST /v1/hub/imports`; P `POST /v1/prompts/revisions`. |
| HUB03-HUB04 | E `POST /v1/package-resolutions`; P `GET /v1/hub/artifacts/{artifact}`. |
| HUB05-HUB06 | P `POST /v1/connected-apps/consents`; P `POST /v1/connected-apps/invocations`. |
| LIVE01-LIVE03 | E `POST /v1/sources/intakes` for private manual staging; E `POST /v1/sources/acquisitions/open-library/works` for bounded single-Work capture; E `POST /v1/sources/acquisitions`, E `GET /v1/sources/runs/{run}` and E `GET /v1/sources/runs/{base}/drift/{candidate}` for a frozen run and its field drift; E `GET /v1/sources/observations/{observation}`; E `GET /v1/sources/conversions/{conversion}`; E `POST /v1/sources/conversions/{conversion}/source-graph` and E `GET /v1/sources/conversions/{conversion}/source-graph`; E `POST /v1/sources/proposals/{proposal}/adoption/native-work`, E `GET /v1/sources/proposals/{proposal}` and E `GET /v1/sources/proposals/{proposal}/adoption/native-work` for title-only new-Work adoption; E `GET /v1/works/{id}/source-support` for exact private historical support and current disposition; E `GET /v1/works/{id}/source-refresh-assessments/{candidateProposal}` for a read-only later source assessment; E `POST /v1/works/{id}/source-title-applications/{candidateProposal}` and E `GET /v1/works/{id}/source-title-applications/{candidateProposal}` for guarded same-epoch title refresh; E `GET /v1/works/{id}/title-control` and E `POST /v1/works/{id}/title-control/source-return`; E `POST /v2/works/{id}/source-supports`, E `GET /v2/works/{id}/source-supports` and E `GET /v2/works/{id}/source-supports/{binding}`; E `POST /v1/works/{id}/source-support/withdrawal` and E `POST /v2/works/{id}/source-supports/{binding}/withdrawal` for one exact title-binding disposition. P complete field-control and cross-epoch resolution operations. |
| LIVE04-LIVE06 | E `GET /v1/sources/conversions/{conversion}`; E `GET /v1/sources/conversions/{base}/drift/{candidate}`; E `GET /v1/sources/conversions/{base}/child-correspondences/{candidate}` for a read-only occurrence assessment; E `POST /v1/sources/correspondences` and E `GET /v1/sources/correspondences/{correspondence}` for an explicit ambiguous source-only child match; E `POST /v1/works/{id}/source-author-credits`, E `GET /v1/sources/author-credit-supports/{support}` and E `POST /v1/sources/author-credit-supports/{support}/withdrawals` for bounded native author credit and independent support; E `POST /v1/works/{id}/source-support/withdrawal`, E `POST /v2/works/{id}/source-supports`, E `GET /v2/works/{id}/source-supports`, E `GET /v2/works/{id}/source-supports/{binding}` and E `POST /v2/works/{id}/source-supports/{binding}/withdrawal` for a recorded title binding. P general `POST /v1/sources/withdrawals`, child retirement and provider identity reconciliation. |
| LIVE07-LIVE09 | E `POST /v1/sources/acquisitions/open-library/works` for bounded Work capture; E `POST /v1/sources/observations/{observation}/conversions/open-library-work` for source-qualified staging; E `POST /v1/sources/acquisitions`; E `GET /v1/sources/runs/{run}`; E `GET /v1/sources/runs/{base}/drift/{candidate}`; E `GET /v1/sources/observations/{observation}`; E `GET /v1/sources/conversions/{conversion}`; E `GET /v1/sources/conversions/{base}/drift/{candidate}`; E `POST /v1/sources/conversions/{conversion}/source-graph`; E `GET /v1/sources/conversions/{conversion}/source-graph`; E `POST /v1/sources/conversions/{conversion}/proposals/native-work`. |
| LIVE10-LIVE12 | E `POST /v1/sources/acquisitions/open-library/works` for a bounded available surface; E `POST /v1/sources/acquisitions`; E `GET /v1/sources/runs/{run}`; E `POST /v1/sources/feeds`; E `GET /v1/sources/feeds/{feed}`; E `POST /v1/sources/feeds/{feed}/baselines` and E `POST /v1/sources/feeds/{feed}/windows` for dump then change intake. P `POST /v1/exports`. |
| LIVE13-LIVE15 | E `POST /v1/sources/intakes` for private manual staging; E `POST /v1/rights/use-assessments`; E `POST /v1/rights/use-evaluations`. P `POST /v1/exports`. |
| LIVE16-LIVE18 | E `POST /v1/sources/intakes` for a non-retained record; E `POST /v1/sources/acquisitions`; E `POST /v1/rights/use-assessments`; E `POST /v1/rights/use-evaluations`; E `POST /v1/rights/restrictions`. P `POST /v1/exports`. |
| PKG01-PKG06 | E `POST /v1/package-resolutions` and E `GET /v1/package-resolutions/{resolution}` for bounded Go snapshots; E `POST /v1/package-resolutions/cargo` and E `GET /v1/package-resolutions/cargo/{resolution}` for bounded exact Cargo resolver 2 v1/v2/v3 snapshots, including `links` conflict and admitted-lock yanked eligibility; E `POST /v1/package-resolutions/npm` and E `GET /v1/package-resolutions/npm/{resolution}` for caller-supplied npm lockfile-v3 nested and peer-host topology; E `POST /v1/package-sources/go`, E `GET /v1/package-sources/go/{capture}`, E `POST /v1/package-sources/go/{capture}/verify`, E `GET /v1/package-sources/go-verifications/{verification}` and E `POST /v1/package-resolutions/from-captures` for the bounded captured Go path; E `POST /v1/package-resolutions/nix` and E `GET /v1/package-resolutions/nix/{resolution}` for bounded Nix snapshots. P other ecosystem profiles, full resolver/provider/installation behavior. |
| PKG07-PKG13 | E `POST /v1/package-resolutions`, E `GET /v1/package-resolutions/{resolution}`, E `POST /v1/package-resolutions/cargo`, E `GET /v1/package-resolutions/cargo/{resolution}`, E `POST /v1/package-resolutions/npm` and E `GET /v1/package-resolutions/npm/{resolution}` for bounded incomplete/unsupported/budget outcomes; E `POST /v1/package-resolutions/mods` and E `GET /v1/package-resolutions/mods/{resolution}` for bounded mod capture. Cargo v2/v3 has selected native `links` unsatisfiability and v3 lock/index checksum inconsistency; npm v1 retains peer-host topology without fresh range solving. P other ecosystem profiles and general unsatisfiable/timeout outcomes. |
| PKG14 | E `POST /v1/package-sources/go/{capture}/verify`; E `GET /v1/package-sources/go-verifications/{verification}` for exact `go.mod` provenance only; E `POST /v1/package-locks`; E `GET /v1/package-locks/{lock}`; E `POST /v1/package-locks/{lock}/replays`; E `GET /v1/package-lock-replays/{replay}`. |
| PKG15-PKG17 | E `POST /v1/package-installations`; E `GET /v1/package-installations/{installation}`; E `POST /v1/package-installations/{installation}/generations`; E `GET /v1/package-installations/{installation}/generations/{generation}`; E `POST /v1/package-installations/{installation}/generations/{generation}/apply`; E `POST /v1/package-artifacts/revocations`. P `POST /v1/package-installations/{installation}/recoveries`. |
| PKG18-PKG19 | E `POST /v1/package-resolutions`; E `GET /v1/package-resolutions/{resolution}`. |
| PKG20 | E `POST /v1/sources/acquisitions`; E `POST /v1/package-resolutions`. |
| VIEW01 | E `POST /v1/addresses/claims`; E `GET /v1/addresses/work/{slug}`. |
| VIEW02 | E `POST /v1/addresses/renames`; E `POST /v1/addresses/dispositions`; E `GET /v1/addresses/work/{slug}`; E `GET /v1/works/{id}/addresses`; E `GET /v1/addresses/work/{slug}/revisions/{revision}`. Transitive merge-chain reads traverse at most 32 Work hops; a longer, broken or cyclic route is unavailable (503). |
| VIEW03 | P `POST /v1/zones/{zone}/mounts`; P `GET /v1/zones/{zone}/resources/{resource}`. |
| VIEW05 | P `POST /v1/zones/{zone}/queries`; E `POST /v1/queries`. |
| VIEW06 | P `PATCH /v1/zones/{zone}/configurations`; P `GET /v1/zones/{zone}`. |
| VIEW07 | E `GET /v1/public-previews/{resource}`; E `GET /v1/sitemap`; E `GET /v1/resources/{resource}` summary with current-disclosure-qualified avatar; E `GET /v1/media/avatars/{selection}`; E `POST /v1/media/assets/{asset}/state`. |
| VIEW08 | E `GET /v1/me/main-versions/{mainVersion}/selection`; E `GET /v1/me/realms/{realm}/main-versions/{mainVersion}/selection`; E `GET /v1/main-versions/{mainVersion}/native-variants`; E `GET /v1/resources/{resource}`; E `POST /v1/resources/summaries`; E `PUT /v1/resources/{resource}/avatar`; E `POST /v1/media/uploads`; E `PUT /v1/media/uploads/{upload}/bytes`; E `POST /v1/media/assets/{asset}/state`; E `GET /v1/media/avatars/{selection}`. |
| VIEW09 | P `POST /v1/themes/{theme}/activations`; P `GET /v1/themes/{theme}`. |
| COMP01-COMP02 | E `POST /v1/compositions`; E `POST /v1/compositions/{id}/changes`; E `POST /v1/compositions/{id}/seals`; E `GET /v1/compositions/{id}`; E `GET /v1/compositions/{id}/occurrences/{occurrence}`. |
| COMP03-COMP04 | P `POST /v1/compositions/{composition}/stages`; P `POST /v1/compositions/{composition}/activations`. |
| COMP05-COMP06 | E `POST /v1/compositions/{id}/changes`; E `GET /v1/compositions/{id}/revisions/{revision}`; E `GET /v1/compositions/{id}/occurrences/{occurrence}`; E `POST /v1/compositions/{id}/seals`. |
| COMP07-COMP08 | P `POST /v1/owners/relocations`; P `POST /v1/exports`; E `GET /v1/revisions/{revision}`. |
| WIKI01-WIKI02 | P `POST /v1/zones/{zone}/mounts`; P `POST /v1/collections/{collection}/changes`. |
| WIKI03-WIKI04 | P `GET /v1/collections/{collection}/members`; P `POST /v1/collections/{collection}/captures`. |
| WIKI05-WIKI06 | E `POST /v1/publication-selections`; P `POST /v1/collections/{collection}/changes`. |
| BOOK01 | E `POST /v1/works`; E `POST /v1/content-drafts`; E `POST /v1/content-publications`; E `POST /v1/compositions`; E `POST /v1/compositions/{id}/changes`; E `GET /v1/compositions/{id}`. |
| BOOK02-BOOK03 | E `POST /v1/compositions/{id}/changes`; E `GET /v1/compositions/{id}/occurrences/{occurrence}`; E `POST /v1/fixed-releases`. |
| BOOK04-BOOK05 | E `POST /v1/content-comments`; E `GET /v1/content-comments/{comment}`; E `GET /v1/content-revisions/{revision}/comments`; E `POST /v1/content-edits`; E `POST /v1/contribution-edits`; E `GET /v1/content-revisions/{revision}`. |
| BOOK06-BOOK08 | P `POST /v1/compositions/{composition}/activations`; P `POST /v1/sources/adoptions`; P `POST /v1/compositions/{composition}/restorations`. |
| BOOK09-BOOK10 | E `POST /v1/media/publications`; E `GET /v1/media/uses/{use}`; E `POST /v1/content-edits`; E `POST /v1/me/acting-context-checks`. |
| RECIPE01-RECIPE02 | P `POST /v1/recipes/{recipe}/revisions`; P `POST /v1/recipes/{recipe}/scalings`. |
| RECIPE03-RECIPE04 | E `POST /v1/sources/intakes`; E `POST /v1/publication-selections`. |
| RECIPE05-RECIPE06 | P `POST /v1/recipes/{recipe}/nutrition-calculations`; P `POST /v1/sources/withdrawals`. |
| FACT01-FACT02 | E `POST /v1/claims`; E `GET /v1/claims/{claim}`; E `POST /v1/claims/{claim}/evidence`; E `GET /v1/claims/{claim}/evidence/{revision}`; E `POST /v1/claims/{claim}/assessments`; E `POST /v1/source-reliability-assessments`; E `POST /v1/verification/origins`; E `POST /v1/sources/observations/{observation}/lineage`; E `POST /v1/verification/lineage/{edge}/retraction`; E `POST /v1/sources/observations/{observation}/derivation`. P `POST /v1/sources/observations`. |
| FACT03-FACT04 | E `POST /v1/claims/{claim}/assessments`; E `GET /v1/claims/{claim}/assessments/{assessment}`; E `GET /v1/claims/{claim}/corrections`; E `POST /v1/source-reliability-assessments`. |
| FACT05-FACT06 | P `POST /v1/exports`; E `POST /v1/claims/{claim}/challenges`; E `GET /v1/claims/{claim}/challenges`; E `POST /v1/claims/{claim}/challenges/{challenge}/withdrawal`. |
| GOV01-GOV03 | E `POST /v1/reports`; E `GET /v1/reports/{report}`; E `POST /v1/moderation/decisions`; E `POST /v1/governance/process-steps`. |
| GOV04 | P `POST /v1/rights/offerings/{offering}/changes`; P `GET /v1/rights/offerings/{offering}`. |
| GOV05-GOV06 | P `POST /v1/deliveries`; E `GET /v1/deliveries/{delivery}`; E `GET /v1/me/notifications`; E `GET /v1/me/notifications/hint`; E `PUT /v1/me/notification-preferences`; E `PUT /v1/me/notification-endpoints/push`; E `POST /v1/notification-providers/{provider}/events`. |
| GOV07-GOV08 | E `POST /v1/erasures`; E `GET /v1/deliveries/{delivery}`; E `GET /v1/me/notifications`; E `GET /v1/me/notifications/hint`; E `PUT /v1/me/notification-read-watermarks/inbox`; E `POST /v1/me/notification-streams/inbox/resets`. |
| GOV09-GOV10 | P `POST /v1/ratings/fit-observations`; P `POST /v1/ratings/spoiler-observations`. |
| GOV11-GOV12 | P `POST /v1/polls/{poll}/ballots`; P `GET /v1/polls/{poll}/tallies`. |
| GOV13-GOV14 | P `POST /v1/polls/{poll}/allocations`; P `POST /v1/polls/{poll}/openings`. |
| GOV15-GOV16 | P `POST /v1/polls/{poll}/ballots`; P `POST /v1/polls/{poll}/mandate-approvals`. |
| GOV17-GOV18 | P `POST /v1/polls/{poll}/ballots`; P `GET /v1/polls/{poll}/charter`. |
| GOV19-GOV20 | P `POST /v1/polls/{poll}/proxies`; P `POST /v1/polls/{poll}/ballots`. |
| GOV21-GOV22 | P `GET /v1/polls/{poll}/tallies`; P `POST /v1/polls/{poll}/reconciliations`. |
| GOV23 | P `POST /v1/proposals/{proposal}/executions`; P `GET /v1/proposals/{proposal}`. |
| GOV24-GOV25 | E `POST /v1/rights/complaints`; E `POST /v1/rights/restrictions`; E `POST /v1/governance/process-steps`. |
| SYS01-SYS03 | P `POST /v1/agents`; E `POST /v1/works`; E `GET /v1/revisions/{revision}`; E `POST /v1/editorial-protections`; E `POST /v1/corrections`; E `POST /v1/corrections/{proposalRevision}/decisions`; E `GET /v1/corrections/{proposalRevision}`; E `GET /v1/corrections`; E `POST /v1/editorial-state-queries`. |
| SYS04-SYS05 | P `POST /v1/owners/reconciliations`; E `POST /v1/content-publications`. |
| SYS06-SYS08 | E `POST /v1/sources/acquisitions`; E `POST /v1/package-installations`; E `POST /v1/erasures`. |
| SYS09-SYS11 | E `POST /v1/works`; E `POST /v1/content-publications`; E `GET /v1/revisions/{revision}`; E `POST /v1/editorial-protections`; E `POST /v1/corrections`; E `POST /v1/corrections/{proposalRevision}/decisions`; E `GET /v1/corrections`; E `POST /v1/editorial-state-queries`. |
| SYS12-SYS14 | P `POST /v1/owners/reconciliations`; E `POST /v1/works`; E `GET /v1/revisions/{revision}`; E `POST /v1/editorial-protections`; E `POST /v1/corrections`; E `POST /v1/corrections/{proposalRevision}/decisions`; E `GET /v1/corrections`; E `POST /v1/editorial-state-queries`. |
| REC01-REC02 | E `POST /v1/recommendations/queries`; E `POST /v1/recommendations/generation-builds`; E `GET /v1/recommendations/generations/{generation}`. |
| REC03-REC04 | E `POST /v1/recommendations/generation-builds`; E `GET /v1/recommendations/generations/{generation}`; E `POST /v1/recommendations/generation-activations`. |
| REC05-REC06 | E `POST /v1/recommendations/queries`; E `POST /v1/recommendations/pages`; E `GET /v1/recommendations/generations/{generation}`. |
