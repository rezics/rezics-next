# Shared Studio editing language

Decision: localize the shared Book/column editing visit with `studio_workspace_*` messages in all eight launch
locales; stable typed operation and completion identities own publication locks and composer completion, independent
of display wording. Existing account, saved-version, release, organizer, picker, history and root-append messages keep
their owners. Safe supplied failure explanations remain verbatim beside localized recovery from native outcome kinds.
User titles, bodies, exact IDs and saved timestamps stay intact. An absent document title stays empty in the editor;
headings and navigation use its supplied Post ID rather than inventing a title.

The visit distinguishes private saving, saved/unsaved preview and separate publication review. Saving retains newer
working edits; explicit switch/discard keeps existing dirty, snapshot and upload protection and focus behavior.
Unavailable/unknown command results keep the frozen intent for explicit same-key/credential replay. No automatic
retry, network call, parser, admission rule or command behavior is added. Typed `operation` and `result` are behavioral
identities; `busy` and `message` are localized presentation only. Source/session/locale retirement stays with the
existing owning visit.

Sources read before design: this owner document, Web's [outcome and acceptance](../../../../docs/goals/web.md#acceptance),
`workspace.tsx`, `controller.ts`, `contract.ts`, `routes/studio.tsx`, `tests/studio-native-drafts.test.tsx`,
`tests/studio-publication-language.test.tsx`, the mounted saved-version fixture and Impeccable's craft floor.
The base has the published-reader and root-append visits but still has English shared editing copy and text-dependent
publication/composer behavior; no merge or cherry-pick is needed.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-workspace-language.test.tsx
 tests/studio-native-drafts.test.tsx tests/studio-publication-language.test.tsx src/studio/publication-withdrawal.test.tsx`.
The focused mounted workspace/controller regression covers all eight locales, initial/empty and read-only states,
private saved/unsaved preview, save feedback with newer edits, dirty switch/discard, stale/unavailable guidance, immutable
uncertain replay, non-English publication locks and composer completion with different display wording. Authored
fixtures are not native or visual proof. Source checks are changed-file formatting, catalogue key/argument parity,
one changed-UI detector run and one affected Web typecheck. Ordinary acceptance, native/browser/keyboard,
phone/desktop visual review, Storybook, legacy parity and promoted-source acceptance remain unverified obligations.
