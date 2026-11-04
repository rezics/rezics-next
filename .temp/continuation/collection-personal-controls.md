goal: web
manager: web

# Complete Collection personal controls

## Current state

The clean base already keeps Collection member actions unavailable when the installed `@rezics/client`
declaration has no `viewerFacts.rows[].actions`. The app owner contract requires this fail-closed behavior and forbids
inferring grants from Entry or vote facts. The server source has a typed actions producer, but the installed public
client declaration still exposes only `rowKey`, `subjectId`, `entry`, and `vote` for each current viewer fact.

Do not hand-edit generated declarations, add a local wire union, reflectively accept undocumented fields, or dispatch
personal writes from Collection. The existing original-Subject Entry, progress, and vote hosts remain the only writers.

## Resume when the producer type is installed

1. Derive the row action closure from the installed `KernelClient.collections({ collectionId }).members.get` response.
2. Preserve occurrence row keys, duplicate rows, original Subjects, exact account/resource/operation binding, current
   empty grants, unavailable states, final source and membership rechecks, and the existing bounded read.
3. Replace the unavailable member-action seam in `collection-viewer/model.ts` and `collection-member-row.tsx`; wire
   only the existing Entry, progress, and vote controls. Keep uncertain commands bound to their original credentials,
   keys, revisions, and operands with no automatic replay.
4. Update `collection-viewer.test.tsx` and the existing Collection viewer story with the concrete ready state and the
   named duplicate/empty/unavailable cases. Preserve unchanged assertions and keep tests smaller than product code.
5. Type-check `apps/web` and run the focused Collection viewer test with the task contract's landing command. Native
   and browser acceptance stays with the controller.

## Owner seam

Producer preparation must publish the server's current/unavailable row closure through the installed root client
declaration. Resume against that actual installed type; do not copy its schema into Web.
