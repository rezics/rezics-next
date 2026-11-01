# Private decision reads and retirement

The served Decision route and these Pages/Patterns share `DecisionPageView`. The production BFF uses the generated
`KernelClient` for one exact decision read, one independent current post/thread read, and a final exact private
decision recheck. There is no history, enumeration, target fallback or additional producer. Target failure withholds
its text and link; it cannot admit or revoke the author's private decision. Native decision denial discards the
entire page. The private decision stays readable after the inclusive 183-day appeal deadline.

The original decision, current outcome, independently read current target and appeal use the shared
`ContentItemFrame` and named `ContentItemHeading` anatomy. The full original reason, submitted appeal draft, independent
review statement, deadline and outcome time remain readable. A withheld target has no link or identifier spill; an
available target stays a separate link beside the open appeal form. Pending, reversed and upheld cases have no extra
appeal action. `OpenWithAvailableTarget` exercises the independent link and form; the uncertain-retry story checks the
same complete draft and immutable command on both attempts.

Prepared sessions supply the viewer, CSRF session epoch and a fresh read generation. Credentials remain server-only;
responses and Kernel reads are private/no-store. SSR can render the prepared page. After hydration, only the matching
known browser viewer and session epoch admit it. Initial unknown identity is loading; a failed session read offers
explicit retry. A subject change, session change/loss, new prepared read, decision navigation or unmount ends the
mounted private visit. Statements, draft, intent/key and pending settlements retire together, including when the
target was already withheld. Returning to the previous session cannot revive the visit: another explicit current
read must admit a new one. Route reads are uncached and aborted navigation cannot deliver a page.

Refresh validates the prepared viewer and session as well as decision/target identity. Transient current-read
failure hides the old page and offers explicit retry without native error details; final denial remains concealed.
The platform's native closed outcome has its own safe presentation. An unrelated target read failure cannot undo a
confirmed appeal. No background refresh or automatic resubmission follows a command.

Read admission is no command grant. Native writes still check the current author, deadline and one-appeal rule.
Uncertain appeal attempts retain their immutable statement and UUID for explicit exact retry, even through a failed
manual refresh. A successful read without an appeal does not settle that uncertainty. There is no browser storage.
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
settlement, exact retry across transient failure, final denial, navigation and unmount. It is authored **UNRUN**;
the controller owns original acceptance/native/browser/story execution. Workspace typing is a separate source gate.

Source read: the tracked moderation/appeals design; existing decision, action, intent and session contracts;
Kernel's content README, moderation decision reader, appeal routes and schemas; and the pinned Discourse
`app/models/reviewable_flagged_post.rb` and Lemmy `crates/db_schema/src/source/post_report.rs` referenced by that design.
These references informed separation of current target disclosure from retained moderation evidence; no code was
copied. The independent Appeals reader's owner-document section is unchanged.
