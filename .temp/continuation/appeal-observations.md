# Goal content

The installed workspace package `@rezics/client` resolves to `packages/client` and exports `KernelClient` from
`src/index.ts`. Its Board and thread `appeals.get` declarations in `src/kernel/content/routes.d.ts` include the exact
selected appeal and parent provenance, but `provenance` omits `sourceObservations` at source head
`e043c2325212939c9af020db42f3d6b0b0cdd145`. The native producer inputs remain in
`services/kernel/src/content/appeal-routes.ts` and `services/kernel/src/content/appeals.ts`.

After the complete-input publisher supplies the installed field, derive observation and selected-appeal types from the
actual Board/thread callable and consume them in `apps/web/src/moderation/appeals-read.ts`. Keep own-property admission,
runtime wire checks, exact per-ID partition/epoch/position coverage, and independent actor/client/authentication-epoch
checks. Do not edit generated trees or add a local DTO, cast, or overlay. Preserve the committed mounted return-focus
work. Run the Web typecheck and focused current-selection test after integration.

# Manager content

Have the publisher verify and emit the complete installed root from the existing native schema, type, and registration
inputs, then report its actual installed head and Board/thread callable. Integrate that output before reopening this
consumer seam. The verifier retains native HTTP, Access, signed-account, growth, browser, and root acceptance.
