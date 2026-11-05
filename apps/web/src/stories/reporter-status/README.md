# Reporter status

The private report route reuses `ReporterStatusPage` and `ReporterStatusView`. The receipt leads with an explained
pending, actioned or dismissed disposition and a Submitted/Reviewed timeline using the native timestamps. Submitted
reason and evidence have separate readable sections. Pending means a null native outcome. Actioned stays actioned
after an appeal. Available and unavailable are current annotations; neither creates a target link or another read.
The unavailable item retains the reporter's evidence. Missing evidence is stated explicitly. IDs and any submitted
revision sit in expandable reference details, with native clipboard copying and an honest copy failure message.
The page offers the existing localized Inbox destination; the DTO supplies no authorized target destination.
The page performs one exact report GET with the current viewer credential, with private no-store responses.
A missing or unrelated report uses the same concealed unknown/not-visible state. Service failures use retry without submitting another report.

The complete receipt uses the shared `ContentItemFrame` for its timeline, submitted evidence, target annotation and
expandable reference, with named `ContentItemHeading` section headings. The entire submitted reason and evidence,
both UTC timestamps and all existing reference values stay available. Target availability remains annotation only:
neither the available nor unavailable state adds a target link, body, reporter identity or moderation spill. Reference
IDs remain inside the native disclosure beside the existing exact-label clipboard action. The `FullEvidence` pattern
keeps a long submission visible and checks both timestamps and the reachable report, target and revision references.

Patterns/Reporter status uses the same presenter as Pages/Reporter status. Review the same IDs with phone390 and
desktop1280 viewport globals, locale and theme globals; no viewport or locale exports. Pattern IDs:
`patterns-reporter-status--pending`, `--actioned`, `--dismissed`, `--target-unavailable`, `--full-evidence`, `--submitted-details`, `--native-error`, `--retry`.
Page ID: `pages-reporter-status--submitted-report`. It uses the actual route, shared site shell and existing
report-unavailable fixture rather than another page wrapper. Plays cover status/reference visibility, native
details opening, clipboard outcome, absence of target links and keyboard retry that remains failed on refusal.
Fixtures follow the adopted wire shape; native acceptance and Root screenshots remain
pending under the minimal verification instruction. A story is not native authority evidence or visual approval.

The default route returns a private prepared-read envelope, binding the report identity and read generation to the
actual prepared viewer and the session's existing CSRF identity. The browser compares that identity only in memory
against the real session query cache; it neither persists nor logs it. It is an identity comparison, never command
permission. A valid prepared SSR response remains renderable. An unknown browser session conceals the submission.
Pure presenter fixtures may still inject `report` and `onRetry` directly; these are not production admission paths.

Session logout, account replacement, replacement sessions for the same account, report navigation and unmount retire
the old journey. Returning to an old session cannot revive retired results. The route observes session changes during
a pending read and through handover to the mounted page using an in-memory session generation; mounted reads and retries drop private bytes before any
asynchronous settlement. Navigation aborts the old admission; navigation and reload events also retire mounted generations immediately. Clipboard success/failure from an obsolete journey is
ignored. Route entries are immediately stale and have no retained cache lifetime.

Loading, native transient failure with explicit recovery, concealed unknown/not-visible and native `platform_closed`
are separate states. Only the transient failure offers retry. There is no automatic retry, anonymous fallback,
raw problem disclosure, fabricated empty report, target read or target link. Each explicit attempt makes one exact
report GET; the public `loadReporterStatus` retains its original 404/null versus transient rejection contract.

Additional pattern IDs in the same family: `--loading`, `--concealed`, `--platform-closed`, `--recovery`,
`--session-retirement`. Additional page fixtures: `pages-reporter-status--read-unavailable` and `--session-retired`;
these exercise the same page states inside AppShell. Recovery is an explicit presenter fixture, not native evidence.
Session retirement uses the production composition and real session query-cache replacement with a withheld target. The default-composition
regression in `reporter-status.test.ts` covers prepared session reads, transient recovery, concealed native denial,
pending route/read and retry retirement, logout, account and same-account session replacement, and obsolete clipboard
settlement. It is authored **UNRUN** under the implementation worker's typing-only policy; controller acceptance,
native, Storybook and browser verification remain deferred.
