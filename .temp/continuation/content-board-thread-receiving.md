# Continue Board and thread receiving

Goal: content  
Manager: content

## Publication required

The implementation base has the native Board and thread projections, but the installed `@rezics/client` route types
do not publish the consumer contract. Complete this work after the official client publication includes:

- `BoardPageResponse.pinRevision` and the registered Board `pin-advice` callable.
- Root `ReadingPageResponse.documentMedia`, `mentions`, `reviewContext` and `conversationActivity`.

The current Board pin owner keeps `inspectSelected` unavailable until both Board fields are installed. The current
thread page keeps its document-media and mention reads and unavailable review/activity presentation until the root
reading-page fields are installed. Preserve those gates meanwhile; do not patch generated declarations, add DTOs or
casts, import private Kernel types, call a route directly, or add a second hydration path.

## Finish

Bind the published advice callable through the existing private no-store server function, passing validated selection,
original request/session and current client. Consume required `pinRevision` directly from the admitted Board page.
Replace thread media/mention hydration with the installed root projections, pass review context through the current
thread context, and adapt activity through its existing display adapter. Preserve the existing renderer, reader,
commands, selected occurrence/page/cursor return and retiring leases.

Add the connected mounted Board-to-thread acceptance for selected advice, pin/unpin, admitted generation, exact
selected-post reading and return, plus the first/continued/exact-selected page tests for images, mentions, review
citations, activity refresh and source/session retirement. Keep installed, native and mounted acceptance distinct;
browser and root checks remain with the verifier. Typecheck each changed workspace and run the focused landing
commands after committing the implementation.
