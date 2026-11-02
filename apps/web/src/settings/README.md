# Settings account reads

Embedded inventory, detail, action-entry and rename-entry reads use a ten-second deadline including response bodies, composed with caller cancellation; timeout releases pending state into the existing localized retry views, and only deliberate recovery rechecks the current account. Independent feeds retain valid cursors and usable pages on transient failure; session retirement discards late replies. Cancellation never proves that a dispatched command had no effect and never replays a mutation.
