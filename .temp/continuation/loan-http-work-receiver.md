# Private loan HTTP work receiver

Goal: performance. Manager: performance.

The Library routes now pass each whole loan request through the optional `loanHttpWork` owner, preserving the exact
request, actor, input and absolute deadline with worker allowance zero. `KernelDependencies` forwards that callback
to `personalLibraryRoutes`; it must be supplied by the sole manifest owner using the original funded
`NativeCollectionWork` frame. Do not create a second ledger or allowance in Library or change the operation
manifest. Keep authorization before receipt replay, one owner and deadline through retries, and the mounted read's
generation/page revalidation, current-copy/Person disclosure and response handling inside the callback.

Finish when the manifest owner binds the existing frame at that seam and the original focused native loan journey,
the six named loan/model/growth suites and the five Search receiving suites pass. Native receiving and acceptance are
deferred to the verifier for this attempt.
