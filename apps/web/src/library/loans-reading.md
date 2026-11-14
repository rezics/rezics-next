# Private loan review

The native [loan contract](../../../../docs/library-loans.md) owns permissions, dates, receipts, cursor order and
copy/person disclosure. Web projects the supplied page once, in its native order, with one selected operation and
one retained command intent. It neither resolves identities nor invents a return permission for an unavailable copy.

Decision: creation uses Copies' existing selected exact-copy slot. The loans route links there instead of asking
for an ID and guessed revision. Both consumers use `LoanControls` and `LoanCommandIntent`. Financial paths and the
selected-copy read implementation remain with their owners.

A row shows supplied work/copy identity, direction, private counterparty text, start/due/return days and native state.
Review opens a contextual region. Choosing extend or return opens only those fields. Back returns focus to the
operation button; Close returns focus to Review. Closing preserves the mounted selection, including an unresolved
command, for reopening. While pending or uncertain, another row cannot replace that selection. Hidden, missing,
deleted and unsupported context stays explicit; concealed people have no guessed identity or destination.

An attempted command snapshots its operation, exact copy or loan revision, dates, untrimmed counterparty text, key
and credential. Unavailable responses and thrown transport errors retain that snapshot. Retry dispatches exactly
that command with its captured credential while the original visit remains current. A later refusal still leaves
the earlier effect unknown. A definitive first refusal permits correction and a new key. No refresh, replacement
request or observed row is treated as acknowledgement. A native receipt is displayed beside the selected loan;
reading current state is a separate explicit action. Account, credential, route or source retirement clears controls
and fences late responses. No polling, per-row reads, page refill or client date authority is added.

## Deferred acceptance

`apps/web/tests/loan-intent.test.ts` pins lost acknowledgements, exact create/extend/return replay, later refusal,
first refusal correction, concurrent submission and credential/source retirement. The mounted controls cases in
`apps/web/tests/loan-controls.test.tsx` pin deliberate operation selection, retained close/reopen, contextual result,
conflict refresh and focus return. All are source-only until the verifier executes them.

`Library/Loans` stories use actual routed consumers and explicitly illustrative contract-shaped fixtures. Named
states are open/due/undated, returned history, concealed context, unknown exact retry and conflict recovery; the
selected-copy story mounts the installed Copies slot. Manual verification uses Storybook's existing viewport and
navigation controls, including phone wrapping and keyboard Back/Close focus return. These fixtures are not native
recordings and establish no native, keyboard, visual or browser acceptance by themselves.
