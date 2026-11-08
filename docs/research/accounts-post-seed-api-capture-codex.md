# Original Accounts API causal capture

Question: what evidence can distinguish the original recovery, credential replacement and website refresh-family
revocation failures without changing their authority model?

Recommendation: run the existing J03/J04/J10 operations against the same admitted, seeded runtime, using three
new ordinary humans. Capture reached phases independently and retain the original assertions. Record only
allowlisted public response shapes/codes, request field names/presence, authority relationships and native
readbacks. A status alone cannot identify the service defect. Keep request-correlated internal diagnostics
unavailable unless the runtime owner supplies an actual correlation; do not infer one from adjacent log lines.

The implemented API-only selector writes separate evidence and never refreshes the complete nineteen-row census
or starts browser/runtime setup. Recovery distinguishes start, private local delivery, completion, both password
sign-ins and the old session read. Replacement distinguishes stage, approve, apply, the same subject/session
request binding and final password/session reads. Revocation records the exact original six form fields and
client/resource/issuer/token-kind binding before independently reading with the formerly admitted Kernel bearer.

## Primary evidence

- [RFC 7009 sections 2.1–2.2](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1): revocation uses a form-encoded
  token and optional type hint, authenticates the client and checks token ownership. HTTP 200 also covers an
  invalid token. Consequently a successful revoke response alone cannot prove that a previously admitted bearer
  has lost authority. The stronger family/Kernel consequence is this repository's original J10 requirement.
- [RFC 7523 sections 2.2 and 3](https://www.rfc-editor.org/rfc/rfc7523.html#section-2.2): JWT client authentication
  uses the assertion type and assertion fields with issuer/subject/audience validation. Preserve those bindings
  while recording only their presence. Both RFCs are IETF Trust documents under their stated BCP 78 legal terms;
  extracted code components have the stated Simplified BSD terms. No code is extracted here.
- Better Auth, reused read-only clone `.reference/accounts-design/better-auth` beneath the main checkout,
  revision `860c4b936b897e664145b292e14551af1fa5e6a4`, MIT (`LICENSE.md`).
  [`packages/better-auth/src/api/routes/password.ts`, lines 234–331](https://github.com/better-auth/better-auth/blob/860c4b936b897e664145b292e14551af1fa5e6a4/packages/better-auth/src/api/routes/password.ts#L234)
  separates proof lookup, password work, proof consumption and the reset callback. This supports recording phase
  boundaries instead of attributing every completion refusal to password validation.
  [`packages/oauth-provider/src/revoke.ts`, lines 114–196](https://github.com/better-auth/better-auth/blob/860c4b936b897e664145b292e14551af1fa5e6a4/packages/oauth-provider/src/revoke.ts#L114)
  checks credentials and token ownership separately before revocation. It provides a behavior reference, not a
  replacement for REZICS's patched provider or Access-first contract. Nothing from the clone was installed or run.
- Repository owners: [guarded recovery](../../services/auth/README.md#guarded-human-recovery),
  [trusted effects](../../services/auth/README.md#trusted-account-effects),
  [website endpoints](../../services/auth/README.md#endpoints),
  [source diagnostics](../../services/auth/README.md#source-diagnostic-emission) and
  [seeded walks](../development/local-stack.md#seeded-journey-walks). Auth's documented diagnostic projection has
  no request context. Current subject/session binding is preserved; capture adds no permission exception.

## Execution limit and confidence

The manager supplied a prerequisite record rather than an admitted runtime handoff: the retained visual checkout
reported persona registration failure and stack exit 1, with no completed seed result found. This says nothing about
another possible runtime. Actual slot, origins, revision, seed and private fixture paths must come from the existing
visual/seed owner. Until supplied, every original API phase remains unverified. No service defect or causal repair
batch can be justified, and focused selector tests cannot establish API, browser, whole Auth or source-baseline proof.

Confidence is high in the capture boundaries and low in any proposed diagnosis. Actual responses together with
request-correlated trusted diagnostics would change that diagnosis. Recommend repairs only after collecting all
three results; setup ordering stays with capture, runtime startup with its owner, actual defects with Auth/Access.
