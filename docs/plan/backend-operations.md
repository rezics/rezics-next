# Retained backend operation map

This map assigns every retained backend acceptance case to the owner API
operation that must carry its result. `E` means a route exists; it does not mean
the full case passes. `P` is a planned operation boundary, not a callable route
or an approved final wire contract. Reconcile its path, request/response types,
authority and cost contract with the owning capability before implementation.
Operational cases also name root procedures where service startup or physical
recovery cannot itself be an HTTP request. The [backend acceptance scope](backend-acceptance.md)
defines the 276-ID denominator and the one rendered-only exclusion.

| Retained IDs | Owner API operation target |
| --- | --- |
| IAM01-IAM02 | E `/api/auth/*` authorization, token and session operations; E `GET /v1/me/acting-contexts`. |
| IAM03-IAM04 | E `GET /v1/me/acting-contexts`; E `POST /v1/me/acting-context-checks`. |
| IAM05 | E `GET /v1/access/group-scope`; E `POST /v1/access/group-changes`; E `POST /v1/access/group-impact-proposals`; E `GET /v1/access/group-impact-proposals/{proposalId}`; E `POST /v1/access/group-impact-approvals`; E `POST /v1/access/role-revisions`; E `GET /v1/access/roles/{familyId}`; P protected role-impact operations. |
| IAM06 | E `POST /v1/access/membership-changes` and E `POST /v1/access/grant-changes` for Agent episode-dependent grants; E `POST /v1/me/private-membership-consents`, E `POST /v1/access/private-membership-changes` and E `GET /v1/me/private-memberships` for private-principal episodes; E `POST /v1/access/org-realm-changes` for independent Org participation. General group/role/Realm semantics remain planned. |
| IAM07 | P `POST /v1/access/revocations`; E `POST /v1/me/acting-context-checks`; protected command replay. |
| IAM08 | P `POST /v1/agents/recoveries`; P `POST /v1/accounts/recoveries`. |
| IAM09 | E `/api/auth/*` consent, refresh and token introspection operations. |
| IAM10 | E `POST /v1/me/acting-context-checks`; protected command admission. |
| IAM11 | P `POST /v1/accounts/erasures`; E `GET /v1/content-revisions/{revision}`. |
| IAM12 | P `POST /v1/agents/invitations`; P `POST /v1/agents/invitations/{invitation}/acceptances`. |
| IAM13-IAM14 | E `POST /v1/access/grant-changes`; E `GET /v1/access/grants/{grantId}`; E `GET /v1/access/grants`; P role/dependent-grant operations. |
| IAM15-IAM17 | P `POST /v1/access/policy-decisions`; P `POST /v1/access/policy-changes`. |
| IAM18-IAM20 | P `POST /v1/access/interaction-decisions`; P `POST /v1/access/policy-decisions`. |
| IAM21-IAM22 | E `GET /v1/content-revisions/{revision}`; P `POST /v1/access/policy-decisions`. |
| IAM23-IAM24 | E `POST /v1/access/org-realm-proposals`, E `POST /v1/access/org-realm-changes` and E `GET /v1/access/org-realm-participation` for independent Org/Realm participation; E `POST /v1/access/org-realm-moves` for an atomic independent-organization transfer; E `POST /v1/organization-publication-rejections` for exact Realm-local moderation; E `POST /v1/access/managed-organization-grants`, E `GET /v1/access/managed-organization-grants/{grantId}` and E `POST /v1/access/organization-roster-policy` for one explicit managed authority and protected roster operation. P broader quota/review and paid benefits. |
| IAM25-IAM27 | E `POST /v1/me/acting-context-checks`; E `POST /v1/me/representation-requests`; E `GET /v1/access/representation-requests/{requestId}`; E `POST /v1/access/representation-changes`; E `GET /v1/access/representations/{representationId}`; E `POST /v1/access/eligible-org-member-set-grant-changes` and E `GET /v1/access/eligible-org-member-set-grants/{grantId}` for IAM25's exact selected set; P composed representation and wider selectors. |
| IAM28-IAM29 | E `POST /v1/me/acting-context-checks`; P multi-obligation and independent-proof operations. |
| IAM30-IAM32 | E `POST /v1/access/group-changes`; E `POST /v1/access/group-impact-approvals`; E `POST /v1/access/role-bindings`; P protected representation and role approval operations. |
| IAM33-IAM36 | E `POST /v1/me/acting-context-checks`; E `GET /v1/access/group-scope`; E `POST /v1/access/grant-changes`; E `POST /v1/access/representation-changes`; E `GET /v1/access/role-bindings`; E `GET /v1/access/role-bindings/{bindingId}`; P broader proof operations. |
| IAM37 | P `PATCH /v1/catalog/resources/{resource}/descriptions`; E `POST /v1/me/acting-context-checks`. |
| MODEL01-MODEL04 | E `POST /v1/works` with bounded `semanticTypes`; E `GET /v1/revisions/{revision}`; P `POST /v1/semantic/changes`; P `GET /v1/semantic/resources/{resource}/revisions/{revision}`. |
| MODEL05-MODEL06 | E `POST /v1/works/{id}/source-author-credits`; E `GET /v1/works/{id}/author-credits/{credit}/revisions/{revision}` for one immutable external-reference credit profile. P general `POST /v1/relations/changes` and `GET /v1/relations/{occurrence}/revisions/{revision}`. |
| MODEL07 | E `GET /v1/revisions/{revision}`; P `POST /v1/owners/relocations`. |
| MODEL08-MODEL10 | E `POST /v1/works` with bounded `semanticTypes`; P `POST /v1/semantic/changes`; E `POST /v1/me/acting-context-checks`; P `POST /v1/sources/observations`. |
| MODEL11-MODEL12 | E `GET /v1/revisions/{revision}`; P `POST /v1/owners/reconciliations`. |
| MODEL13-MODEL14 | P `POST /v1/semantic/changes`; P `GET /v1/semantic/resources/{resource}`. |
| MODEL15-MODEL18 | E `POST /v1/works`; E `POST /v1/classification-propositions`; P `POST /v1/semantic/changes`. |
| MODEL19-MODEL21 | P `POST /v1/semantic/changes`; P `POST /v1/semantic/resolutions`. |
| MODEL22-MODEL24 | E `POST /v1/works`; P `POST /v1/semantic/changes`; P `GET /v1/model/generations/current`. |
| MODEL25-MODEL27 | E `GET /v1/revisions/{revision}`; E `POST /v1/works`; P `POST /v1/owners/reconciliations`. |
| CTX01-CTX03 | E `POST /v1/spaces`; E `POST /v1/classification-decisions`; E `POST /v1/classification-resolutions`. |
| CTX04-CTX05 | E `POST /v1/classification-propositions`; E `POST /v1/classification-resolutions`. |
| CTX06-CTX07 | P `POST /v1/classification/rule-changes`; E `POST /v1/classification-resolutions`. |
| CTX08-CTX10 | P `POST /v1/classification/vocabulary-changes`; E `POST /v1/classification-resolutions`. |
| WORK01-WORK02 | E `POST /v1/works`; E `POST /v1/contributions`; E `POST /v1/translation-links`; E `GET /v1/main-versions/{mainVersion}/native-variants`. |
| WORK03-WORK04 | E `POST /v1/publication-selections`; E `POST /v1/work-derivations`. |
| WORK05 | E `POST /v1/fixed-releases`; E `GET /v1/fixed-releases/{release}`. |
| WORK06 | E `POST /v1/rating-observations`; E `POST /v1/rating-aggregates`. |
| WORK07 | P `POST /v1/package-resolutions`; P `POST /v1/package-locks`. |
| WORK08 | P `POST /v1/sources/observations`; P `POST /v1/sources/correspondences`. |
| WORK09-WORK10 | E `POST /v1/content-drafts`; E `POST /v1/content-publications`; E `GET /v1/content-revisions/{revision}`. |
| RATE01-RATE02 | E `POST /v1/rating-observations`; E `POST /v1/rating-aggregates`. |
| RATE03-RATE04 | E `POST /v1/rating-contexts` for the daily timezone profile, E `POST /v1/rating-observations` for server-calendar daily slots and exact-head standing/daily `value: null` withdrawal, E `GET /v1/rating-observations/{observation}/revisions/{revision}` for private exact history. Daily aggregation and broader cadence policies remain planned. |
| RATE05-RATE06 | E `POST /v1/rating-contexts`; E `POST /v1/rating-aggregates`. |
| RATE07-RATE09 | P `POST /v1/events/observations`; P `POST /v1/events/queries`. |
| GRAPH01-GRAPH02 | E `POST /v1/queries`; P `POST /v1/relations/changes`. |
| GRAPH03-GRAPH05 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| GRAPH06 | P `POST /v1/graph-layouts`; P `GET /v1/graph-layouts/{layout}`. |
| OPS01-OPS02 | E `GET /health/ready`; owner `yarn toolchain:install`, `yarn stack:up`. |
| OPS03-OPS04 | E `GET /v1/revisions/{revision}`; P `POST /v1/owners/reconciliations`; owner `yarn stack:backup`. |
| OPS05-OPS06 | E `POST /v1/queries`; E `POST /v1/works`; P `GET /v1/operations/backpressure`; owner `yarn load`, `yarn fixture:restore`. |
| OPS07-OPS08 | E `/api/auth/*` token/session operations; E `POST /v1/me/acting-context-checks`. |
| OPS09 | E `POST /v1/queries`; owner `yarn search:rebuild`. |
| OPS10-OPS12 | P `POST /v1/erasures`; P `GET /v1/erasures/{erasure}`; E `GET /v1/revisions/{revision}`. |
| OPS13-OPS14 | E `GET /health/ready`; E `POST /v1/works`; E `POST /v1/queries`; owner `yarn stack:up`. |
| OPS15-OPS16 | E `POST /v1/queries`; P `GET /v1/search/generations/current`; owner `yarn search:rebuild`. |
| SEARCH01-SEARCH02 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH03-SEARCH04 | E `POST /v1/queries`; E `POST /v1/private-queries`. |
| SEARCH05-SEARCH06 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH07-SEARCH08 | E `POST /v1/works`; E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH09-SEARCH10 | E `POST /v1/queries`; E `POST /v1/queries/page`. |
| SEARCH11-SEARCH12 | E `POST /v1/private-queries`; E `POST /v1/me/acting-context-checks`. |
| SEARCH13-SEARCH14 | E `POST /v1/queries`; P `POST /v1/semantic/changes`. |
| SEARCH15-SEARCH17 | E `POST /v1/queries`; owner `yarn search:rebuild`. |
| SEARCH18-SEARCH20 | E `POST /v1/queries`; E `POST /v1/content-search-eligibility`; owner `yarn search:rebuild`, `yarn load`. |
| SUB01-SUB03 | P `POST /v1/subscriptions/quotes`; P `POST /v1/subscriptions/changes`; P `POST /v1/subscriptions/settlements`. |
| SUB04-SUB06 | P `POST /v1/realms/{realm}/quota-reservations`; P `POST /v1/realms/{realm}/review-decisions`; P `POST /v1/realms/{realm}/replies`. |
| SUB07-SUB08 | P `POST /v1/pro-sites/queries`; P `POST /v1/subscriptions/reconciliations`. |
| HUB01-HUB02 | P `POST /v1/hub/imports`; P `POST /v1/prompts/revisions`. |
| HUB03-HUB04 | P `POST /v1/package-resolutions`; P `GET /v1/hub/artifacts/{artifact}`. |
| HUB05-HUB06 | P `POST /v1/connected-apps/consents`; P `POST /v1/connected-apps/invocations`. |
| LIVE01-LIVE03 | E `POST /v1/sources/intakes` for private manual staging; E `POST /v1/sources/acquisitions/open-library/works` for bounded single-Work capture; E `POST /v1/sources/proposals/{proposal}/adoption/native-work` for title-only new-Work adoption; E `GET /v1/works/{id}/source-support` for exact private historical support and current disposition; E `GET /v1/works/{id}/source-refresh-assessments/{candidateProposal}` for a read-only later source assessment; E `POST /v1/works/{id}/source-title-applications/{candidateProposal}` for guarded same-epoch title refresh; E `POST /v1/works/{id}/source-support/withdrawal` for one exact title-binding disposition; P general `POST /v1/sources/acquisitions`; P complete field-control, general withdrawal and cross-epoch resolution operations. |
| LIVE04-LIVE06 | E `GET /v1/sources/conversions/{base}/child-correspondences/{candidate}` for a read-only occurrence assessment; E `POST /v1/sources/correspondences` for an explicit ambiguous source-only child match; E `POST /v1/works/{id}/source-author-credits`, `GET /v1/sources/author-credit-supports/{support}` and `POST /v1/sources/author-credit-supports/{support}/withdrawals` for bounded native author credit and independent support; E `POST /v1/works/{id}/source-support/withdrawal` for a recorded title binding only; P general `POST /v1/sources/withdrawals`, child retirement and provider identity reconciliation. |
| LIVE07-LIVE09 | E `POST /v1/sources/acquisitions/open-library/works` for bounded Work capture; E `POST /v1/sources/observations/{observation}/conversions/open-library-work` for source-qualified staging; P general `POST /v1/sources/acquisitions`; P `GET /v1/sources/runs/{run}`. |
| LIVE10-LIVE12 | E `POST /v1/sources/acquisitions/open-library/works` for a bounded available surface; P `POST /v1/exports`; P general `POST /v1/sources/acquisitions`; P `GET /v1/sources/runs/{run}`. |
| LIVE13-LIVE15 | E `POST /v1/sources/intakes` for private manual staging; P `POST /v1/rights/use-assessments`; P `POST /v1/exports`. |
| LIVE16-LIVE18 | E `POST /v1/sources/intakes` for a non-retained record; P `POST /v1/sources/acquisitions`; P `POST /v1/rights/restrictions`; P `POST /v1/exports`. |
| PKG01-PKG06 | E `POST /v1/package-resolutions` and E `GET /v1/package-resolutions/{resolution}` for bounded Go snapshots; E `POST /v1/package-resolutions/cargo` and E `GET /v1/package-resolutions/cargo/{resolution}` for bounded exact Cargo resolver 2 v1/v2/v3 snapshots, including `links` conflict and admitted-lock yanked eligibility; E `POST /v1/package-resolutions/npm` and E `GET /v1/package-resolutions/npm/{resolution}` for caller-supplied npm lockfile-v3 nested and peer-host topology; E `POST /v1/package-sources/go`, E `GET /v1/package-sources/go/{capture}`, E `POST /v1/package-sources/go/{capture}/verify` and E `GET /v1/package-sources/go-verifications/{verification}` for the bounded captured Go path. P Nix and other ecosystem profiles, full resolver/provider/installation behavior. |
| PKG07-PKG13 | E `POST /v1/package-resolutions`, E `GET /v1/package-resolutions/{resolution}`, E `POST /v1/package-resolutions/cargo`, E `GET /v1/package-resolutions/cargo/{resolution}`, E `POST /v1/package-resolutions/npm` and E `GET /v1/package-resolutions/npm/{resolution}` for bounded incomplete/unsupported/budget outcomes. Cargo v2/v3 has selected native `links` unsatisfiability and v3 lock/index checksum inconsistency; npm v1 retains peer-host topology without fresh range solving. P other ecosystem profiles and general unsatisfiable/timeout outcomes. |
| PKG14 | E `POST /v1/package-sources/go/{capture}/verify`; E `GET /v1/package-sources/go-verifications/{verification}` for exact `go.mod` provenance only; P `POST /v1/package-locks/replays`; P `GET /v1/package-locks/{lock}`. |
| PKG15-PKG17 | P `POST /v1/package-installations`; P `POST /v1/package-installations/{installation}/recoveries`. |
| PKG18-PKG19 | P `POST /v1/package-resolutions`; P `GET /v1/package-resolutions/{resolution}`. |
| PKG20 | P `POST /v1/sources/acquisitions`; P `POST /v1/package-resolutions`. |
| VIEW01 | E `POST /v1/addresses/claims`; E `GET /v1/addresses/work/{slug}`. |
| VIEW02 | E `POST /v1/addresses/renames`; E `POST /v1/addresses/dispositions`; E `GET /v1/addresses/work/{slug}`; E `GET /v1/works/{id}/addresses`; E `GET /v1/addresses/work/{slug}/revisions/{revision}`. Transitive merge-chain reads traverse at most 32 Work hops; a longer, broken or cyclic route is unavailable (503). |
| VIEW03 | P `POST /v1/zones/{zone}/mounts`; P `GET /v1/zones/{zone}/resources/{resource}`. |
| VIEW05 | P `POST /v1/zones/{zone}/queries`; E `POST /v1/queries`. |
| VIEW06 | P `PATCH /v1/zones/{zone}/configurations`; P `GET /v1/zones/{zone}`. |
| VIEW07 | P `GET /v1/public-previews/{resource}`; P `GET /v1/sitemap`. |
| VIEW08 | E `GET /v1/me/main-versions/{mainVersion}/selection`; E `GET /v1/main-versions/{mainVersion}/native-variants`. |
| VIEW09 | P `POST /v1/themes/{theme}/activations`; P `GET /v1/themes/{theme}`. |
| COMP01-COMP02 | P `POST /v1/compositions/{composition}/changes`; P `GET /v1/compositions/{composition}`. |
| COMP03-COMP04 | P `POST /v1/compositions/{composition}/stages`; P `POST /v1/compositions/{composition}/activations`. |
| COMP05-COMP06 | P `POST /v1/compositions/{composition}/changes`; P `GET /v1/compositions/{composition}/revisions/{revision}`. |
| COMP07-COMP08 | P `POST /v1/owners/relocations`; P `POST /v1/exports`; E `GET /v1/revisions/{revision}`. |
| WIKI01-WIKI02 | P `POST /v1/zones/{zone}/mounts`; P `POST /v1/collections/{collection}/changes`. |
| WIKI03-WIKI04 | P `GET /v1/collections/{collection}/members`; P `POST /v1/collections/{collection}/captures`. |
| WIKI05-WIKI06 | E `POST /v1/publication-selections`; P `POST /v1/collections/{collection}/changes`. |
| BOOK01 | E `POST /v1/works`; E `POST /v1/content-drafts`; E `POST /v1/content-publications`; P `POST /v1/compositions/{composition}/changes`. |
| BOOK02-BOOK03 | P `POST /v1/compositions/{composition}/changes`; E `POST /v1/fixed-releases`. |
| BOOK04-BOOK05 | E `POST /v1/content-comments`; E `POST /v1/content-edits`; E `GET /v1/content-revisions/{revision}`. |
| BOOK06-BOOK08 | P `POST /v1/compositions/{composition}/activations`; P `POST /v1/sources/adoptions`; P `POST /v1/compositions/{composition}/restorations`. |
| BOOK09-BOOK10 | P `POST /v1/media/publications`; E `POST /v1/content-edits`; E `POST /v1/me/acting-context-checks`. |
| RECIPE01-RECIPE02 | P `POST /v1/recipes/{recipe}/revisions`; P `POST /v1/recipes/{recipe}/scalings`. |
| RECIPE03-RECIPE04 | P `POST /v1/sources/intakes`; E `POST /v1/publication-selections`. |
| RECIPE05-RECIPE06 | P `POST /v1/recipes/{recipe}/nutrition-calculations`; P `POST /v1/sources/withdrawals`. |
| FACT01-FACT02 | P `POST /v1/claims/{claim}/assessments`; P `POST /v1/sources/observations`. |
| FACT03-FACT04 | P `POST /v1/claims/{claim}/assessments`; P `GET /v1/claims/{claim}/assessments/{assessment}`. |
| FACT05-FACT06 | P `POST /v1/exports`; P `POST /v1/claims/{claim}/challenges`. |
| GOV01-GOV03 | P `POST /v1/reports`; P `POST /v1/moderation/decisions`; P `GET /v1/reports/{report}`. |
| GOV04 | P `POST /v1/rights/offerings/{offering}/changes`; P `GET /v1/rights/offerings/{offering}`. |
| GOV05-GOV06 | P `POST /v1/deliveries`; P `GET /v1/deliveries/{delivery}`. |
| GOV07-GOV08 | P `POST /v1/erasures`; P `GET /v1/deliveries/{delivery}`; P `GET /v1/notifications/stream`. |
| GOV09-GOV10 | P `POST /v1/ratings/fit-observations`; P `POST /v1/ratings/spoiler-observations`. |
| GOV11-GOV12 | P `POST /v1/polls/{poll}/ballots`; P `GET /v1/polls/{poll}/tallies`. |
| GOV13-GOV14 | P `POST /v1/polls/{poll}/allocations`; P `POST /v1/polls/{poll}/openings`. |
| GOV15-GOV16 | P `POST /v1/polls/{poll}/ballots`; P `POST /v1/polls/{poll}/mandate-approvals`. |
| GOV17-GOV18 | P `POST /v1/polls/{poll}/ballots`; P `GET /v1/polls/{poll}/charter`. |
| GOV19-GOV20 | P `POST /v1/polls/{poll}/proxies`; P `POST /v1/polls/{poll}/ballots`. |
| GOV21-GOV22 | P `GET /v1/polls/{poll}/tallies`; P `POST /v1/polls/{poll}/reconciliations`. |
| GOV23 | P `POST /v1/proposals/{proposal}/executions`; P `GET /v1/proposals/{proposal}`. |
| GOV24-GOV25 | P `POST /v1/rights/complaints`; P `POST /v1/rights/restrictions`. |
| SYS01-SYS03 | P `POST /v1/agents`; E `POST /v1/works`; E `GET /v1/revisions/{revision}`. |
| SYS04-SYS05 | P `POST /v1/owners/reconciliations`; E `POST /v1/content-publications`. |
| SYS06-SYS08 | P `POST /v1/sources/acquisitions`; P `POST /v1/package-installations`; P `POST /v1/erasures`. |
| SYS09-SYS11 | E `POST /v1/works`; E `POST /v1/content-publications`; E `GET /v1/revisions/{revision}`. |
| SYS12-SYS14 | P `POST /v1/owners/reconciliations`; E `POST /v1/works`; E `GET /v1/revisions/{revision}`. |
| REC01-REC02 | P `POST /v1/recommendations/queries`; P `POST /v1/recommendations/generation-builds`. |
| REC03-REC04 | P `POST /v1/recommendations/generation-builds`; P `POST /v1/recommendations/generation-activations`. |
| REC05-REC06 | P `POST /v1/recommendations/queries`; P `POST /v1/recommendations/pages`. |
