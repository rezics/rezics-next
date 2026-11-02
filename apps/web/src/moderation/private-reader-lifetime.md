# Private moderation reader lifetime

Reports, Appeals, Decision and Reporter Status capture the original QueryClient and exact successful session Query
before calling their existing server reader. Each server boundary prepares its Request once. The authorization used
for its bounded native reads also supplies the prepared subject and a SHA-256 fingerprint of the prepared CSRF token.
The fingerprint has distinct null and token domains. No bearer, raw CSRF, decoded token or expected browser identity
is transported as provenance. Low-level injected read and presenter APIs remain separate from production admission.

A healthy authenticated initial null-CSRF observation may read when its subject and distinguished null fingerprint
match that actual origin. This replaces the old initial missing-CSRF denial oracles. Unknown, preparing, anonymous,
missing origin, mismatched origin, native refusal and platform closure cannot disclose private evidence. Native
commands still require the existing current token and capability checks. Read admission grants no command authority.

The local cache source observes every external success, including equal data and equal null, error, explicit setState,
removal, recreation and observed hidden away/back transition. Observer, fetch and ordinary rerender notifications do
not retire an otherwise healthy owner. The original exact Query, session tuple and source revision remain checked
before queued effects and after awaits. No raw response root certifies ownership of structurally shared cache data.

The serializable binding carries non-secret comparison evidence and immutable scope identity, not authentication
authority. A same-cache handoff retains its original capture and abort signal. An independent server-to-browser transfer
captures its own known browser observation before comparing both the original expected fingerprint and actual origin.
This cannot establish unobserved credential history between separate caches. A browser-produced read cannot move to
another provider and borrow its observation. An old mounted owner cannot adopt a successor's provider or cleanup.
The local handoff registry correlates the immutable receipt through default cache structural sharing. Its entry holds
the original observation and signal, is claimed by one mounted owner, and is released on abort or retirement. Neither
its correlation ID nor a copied response object authorizes a read without the actual-origin comparison.
An independently transferred server receipt also retains its first browser observation across copied metadata and
remounts in that cache. Weak receipt retention preserves its retirement while the receipt is live; finalization removes
the correlation entry when that observation is collected. No strong retired-page history or history scan is introduced.

Each mounted owner checks its original input, provider, navigation, abort and connection. Retirement is monotonic and
hides obsolete evidence; pending effects and late success, failure and finally callbacks cannot change a successor.
Synchronous StrictMode reconnect may reconnect the same owner. Disconnection immediately fences queued effects and
marks the read unavailable to another mount; final unmount retires after that synchronous replay opportunity.

Recovery is explicit and bounded. A healthy unavailable reader may perform one fresh read with its original scope and
observation. Decision's explicit recovery after retirement creates a new preparation and new owner. A preparation
outage has no actual origin: recovery UI can belong to an observation without tagging private data with that browser's
expected identity. There is no automatic retry, refetch loop, extra session/native identity read or page expansion.

Reporter Status offers explicit refresh for every loaded outcome using that same original reader; loading hides the prior submission and unavailable results reuse retry recovery.

Reports retain individual and sequential bulk controllers, loaded-only maximum 20, immutable payloads/keys and confirmed
receipts. Appeals passes its original-current command callback to AppealResolution before freeze/retry/send/settlement.
Decision retains its immutable uncertain appeal retry and drafts through current transient recovery. Reporter Status
copies only the original reader's own report reference and checks its original connection at copy and settlement.
Definitive refusals require fresh reads. Retirement never turns known native success into uncertainty.

Decision appeal composition registers with the shared authoring departure owner, including standalone presenters.
Nonempty changed statements and immutable sending or uncertain commands require its accessible Stay/Leave decision.
Stay preserves the exact statement, decision and command key through unavailable refreshes and reads without an appeal.
Only an admitted appeal receipt acknowledges the submitted snapshot; subsequent unsaved writing remains protected.
Command and explicit target refresh continuations are independent, so a receipt releases command protection even while
a target read is pending, and a late read without an appeal cannot roll back that receipt. Confirmed Leave synchronously
retires the original private reader and fences both continuations before replacement reads. Existing origin, session,
cache and query admission remain authoritative; standalone injected fixtures acquire no production authority.
Decision: confirmed draft discard forgets only local writing and retry recovery, keeps the current reader, and never
claims to cancel or undo a native request.

Moderator resolution forms share one queue departure decision for nonempty local statements and pending or uncertain
commands. Stay retains exact input and the frozen outcome, payload and key; Leave retires every original intent and
the admitted page before navigation resumes. Validated resolution receipts release protection immediately without a
parent read; persisted outcomes and untouched forms need no decision. Session or admission retirement remains immediate.
Decision: Appeals departure identity includes pathname, tab, thread, post and cursor; unrelated Reports selection metadata preserves the admitted queue and local resolution forms.

Native limits remain 20 Reports/Appeals plus existing distinct-target/revision/author/media enrichment. Subscriptions
are fixed per cache/owner and rendering is O(returned evidence); no history or per-row identity scan is added.

The connected campaign uses actual prepared Request/native-client/server-function seams and mounted QueryClients.
Serialization and createRoot coverage are not hydrateRoot first-paint proof. Private first-render producer/SSR and
unobserved cross-cache credential history remain unresolved; this change retains the existing server presentation
boundary and makes no new SSR authority claim. Shared session, query, producer, command and native proof roots remain
read-only. Canonical story IDs and standalone presenters remain; SessionRetirement is an honest separate presenter
fixture, not fabricated production provenance.

All behavioral, native, browser, SSR/hydration, Storybook, growth and original acceptance assertions are authored or
retained UNRUN for controller integration. Changed-workspace typing alone does not establish those outcomes or Goal
completion. Historical typing evidence in the Reports lifetime document belongs only to that earlier implementation.

The current source typing receipt on 2026-11-02 is `bun run --cwd apps/web typecheck`, run locally from the assigned
worktree root in foreground terminal session 53075. Its existing generation and route-generation prerequisites
completed, followed by `No type errors in 1,546 files [1013.65ms]`, with terminal exit 0. Earlier foreground runs
also passed before the final ownership fixes. No behavioral assertions or other campaigns were executed.
