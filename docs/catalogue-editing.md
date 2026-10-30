## Browser flow: multilingual subject terms

The subject header and compact subject frame offer **Edit names and descriptions** at
`/{locale}/subjects/{id}/{slug}/terms`. The private, noindex page keeps the exact subject identity and reads native
terms with their quoted ETag. Released Type names use the existing locale fallback; data language is a separate
explicit choice. This is catalogue data, separate from Puck presentation documents and cited statement proposals.

Each language shows original names, descriptions and aliases. Keep, replace and remove are explicit choices;
blank replacement inputs are invalid, never implicit deletion. Only intentional changes enter the patch. Other
languages and drafts survive language switches, denials and stale responses. Remaining labels and aliases use
native limits. Current authority and derived-term eligibility belong to the server; server refusal details remain
visible, and a profile link appears only when the existing canonical account lookup supplies it.

The session BFF preserves identity, CSRF, concurrency, idempotency and native session headers. Uncertain delivery
freezes the payload, ETag and key for retry. Stale revisions or conflicting keys require reload, comparison and an
explicit new confirmation. A successful write is followed by a native read of the same returned ID; only that read
supplies current terms and the canonical reader address. Failed or concealed rereads never publish a local preview.

Semantic owns the native terms API. An unavailable operation remains unavailable in the browser; it never becomes
a successful local preview or a substitute catalogue mutation.
