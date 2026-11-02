# Library operation recovery

The standalone operation address reads the native captured action, counts, phase, original execution and results
deadlines, and at most twenty native outcomes at a time. Explicit recovery repeats the same operation and current
native cursor. GET never previews, confirms, cancels or schedules personal effects. Missing, forbidden, invalid and
expired results remain distinct from a successful empty result page. A native expired phase remains visible with
its original deadlines while results are still readable.

Cancellation captures a separate request key, exact operation, original viewer, CSRF token and sender. An uncertain
result permits only explicit retry of that captured command. The server prepares a fresh request, matches the
original viewer and CSRF, and sends complete native authorization and idempotency headers. Native admission owns
all effects. Cancellation preserves already committed target counts and outcomes. Navigation, viewer replacement,
locale retirement and observed exposure retirement reject late disclosure; there is no polling or persistence.

Decision: render native outcome and reason identifiers verbatim, and omit deletion receipts because the current
native outcome binding discloses no receipt; never infer a receipt from an applied removal.
