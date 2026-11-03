# Private decision reads and retirement

The served Decision route and these Pages/Patterns share `DecisionPageView`. The production BFF uses one selected
generated `KernelClient` decision read for the receipt, native appeal advice and optional current target context. It
does not hydrate a post or thread or reread the decision to compose the page. Concealed and unavailable context never
hide the independently readable receipt. Native decision denial discards the entire page. The private decision stays
readable after the inclusive 183-day appeal deadline.

The original decision, current outcome, current native target context and appeal use the shared
`ContentItemFrame` and named `ContentItemHeading` anatomy. The full original reason, submitted appeal draft, independent
review statement, deadline and outcome time remain readable. A withheld target has no link or identifier spill; an
available target stays a separate link beside the open appeal form. Pending, reversed and upheld cases have no extra
appeal action. `OpenWithAvailableTarget` exercises the disclosed current link and form; the uncertain-retry story
checks the same complete draft, idempotency key and captured CSRF header on both attempts.

Prepared sessions supply the private reader origin and a fresh read generation. Native `viewer.appeal` advice, not
local target authorship or readability, controls the form. The generated client currently lacks the complete native
actor/session/source provenance tuple, so production stays on the typed unavailable seam until generated publication
provides it; no prepared private page is currently claimed for SSR. Native Authorization remains server-only. The exact
CSRF request header is kept in visit memory only for an uncertain retry. Responses and Kernel reads are private/no-store.
After hydration, only the matching
known browser viewer and session epoch admit it. Initial unknown identity is loading; a failed session read offers
explicit retry. A subject change, session change/loss, new prepared read, decision navigation or unmount ends the
mounted private visit. Statements, draft, intent/key and pending settlements retire together, including when the
target was already withheld. Returning to the previous session cannot revive the visit: another explicit current
read must admit a new one. Route reads are uncached and aborted navigation cannot deliver a page.

Refresh validates the prepared session and exact native source observation as well as decision identity. Transient current-read
failure hides the old page and offers explicit retry without native error details; final denial remains concealed.
The platform's native closed outcome has its own safe presentation. Command acknowledgement and current readback are
independent; a new native source observation retires the visit, including its draft and delayed focus. No background
refresh or automatic resubmission follows a command.

Read admission is no command grant. Native writes still check the current author, deadline and one-appeal rule.
Uncertain appeal attempts retain their immutable decision ID, statement, UUID and CSRF request header for explicit
exact retry, even through a failed manual refresh. Each attempt prepares native Authorization from the still-admitted
session and native submission reauthorizes. A successful read without an appeal does not settle that uncertainty.
There is no browser storage.
Existing explicitly injected action/refresh fixture pairs remain isolated presentation fixtures; production's
default composition always observes `useSession` and never admits an unknown browser session.

Existing story IDs remain. Both families add `Loading`, `ReadUnavailable`, `ReadClosed`, `PlatformClosed` and
`RefreshRecovery`; use the existing locale/theme and phone390/desktop1280 globals. The recovery play hides private
content during failure and restores the same-session draft only after explicit read retry. Fixtures remain
constructed interface evidence, not native authority.

`tests/moderation-private-case-content-item.test.tsx` composes the production case views and checks their shared frame,
named headings, complete text, separate target disclosure, native timestamps and reachable references.
`tests/moderation-decision.test.ts` adds one default-composition regression using the actual browser session hook,
prepared BFF and generated transport, covering withheld targets, subject/session transitions, late refresh/command
settlement, exact retry across transient failure, final denial, navigation and unmount. The controller owns frozen
acceptance, native, browser and Storybook execution; workspace typing remains a separate source gate.

Source read: the tracked moderation/appeals design; existing decision, action, intent and session contracts;
Kernel's content README, moderation decision reader, appeal routes and schemas; and the pinned Discourse
`app/models/reviewable_flagged_post.rb` and Lemmy `crates/db_schema/src/source/post_report.rs` referenced by that design.
These references informed separation of current target disclosure from retained moderation evidence; no code was
copied. The independent Appeals reader's owner-document section is unchanged.
