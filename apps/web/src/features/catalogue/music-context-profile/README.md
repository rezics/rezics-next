# Music Context companion returns

The dedicated Music Context reader accepts return intent through [navigation](navigation.ts) and renders it in
the [reading view](../../pages/music-context-reading/view.tsx). The shared
[Subject return helper](../../pages/subject-visit-navigation.ts) owns destination grammar.

Decision: validated explicit returns take precedence over the Global-only Subject fallback; preserve selected-Context
Release and Quotations addresses exactly while retaining existing graph and Realm fencing.

An explicit companion return must belong to the same Subject and locale. For a non-default Context, only Release
and Quotations destinations carrying that exact Context are admitted. Their accepted filters, position and encoded
address remain intact. The destination rereads through its existing owner; the return is an ordinary server-rendered
anchor and starts no Music Context request. Its localized label wraps, retains visible keyboard focus and has a
44px minimum phone target.

Global graph returns retain their own graph anchor and admitted coordinates, including their own Context or Realm
disclosure. Those coordinates confer no native Music Context authority: a graph return is admitted only for a Global
companion without Realm. Without an explicit return, only a Global visit without Realm gets the default Subject
return. Other visits keep the existing unsupported-return disclosure and deliberate general Subject link.

The existing binding owns Subject, locale, entered Context, Realm, explicit return and transport replacement. Replacing
it retires pending responses. Stream and cursor replacement, including same-tab Back, keep the existing route-address
fence; a retired response cannot restore its old page or return. The return address does not depend on the native
response or current cursor. The reader still retains one bounded native page and at most eight page coordinates.

External addresses retain the existing parser-bound identities, locale checks, route grammar, exact Context matching
and 32,768-byte UTF-8 budget. Malformed input never becomes an explicit return. Native ordering, sessions, hidden or
denied targets, unavailable readings and retry behaviour remain owned by the current reader.

Focused mounted cases cover exact selected-Context Release and Quotations returns, selection and cursor replacement,
retired responses, same-tab Back and coexistence with Global graph returns. Existing external-input refusal assertions
remain in place. The selected-Context companion story is illustrative; authored tests and stories are not executed
proof. Integration verification owns compiler and test execution, native acceptance, keyboard/phone/theme/locale
review and promotion acceptance.
