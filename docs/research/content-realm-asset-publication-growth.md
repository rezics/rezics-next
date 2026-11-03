# Realm asset publication growth binding

## Owner contract

The Content Cost entry for Realm asset publication bounds one exact source/media row and at most twelve derivative
rows/objects, with constant indexed statements, constant examined rows and logarithmic buffer work as retained
partition history grows. Image decoding keeps the existing 20 MiB and 40-million-pixel limits. This report binds the
Realm-specific native workflow check to that existing cost; it adds no product behavior or authority rule.

## Base and gap

- Base revision: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`, clean retained worktree.
- `media-realm-assets.test.ts` reserves a Realm image over native HTTP but directly calls `createImageJob` to make it
  available. `growth-media.test.ts` measures that same direct job path. Neither captures the registered worker's
  upload event, image workflow, or terminal result for a Realm reservation.
- The added test uses the existing Realm-native fixture, its production Access factory, fixed Sharp PNG bytes, an
  isolated local R2-compatible object store and the registered `registerContent` worker. The worker, HTTP kernel and
  growth observer use instrumented pools for the same isolated database.

## Operation binding

Setup creates the Realm and worker runtime. Each selected operation records a refused non-manager reservation,
reserves a Realm icon through native HTTP, writes the source bytes to isolated storage, and completes the upload with
the same account's website credential. It binds the uploaded event's partition/position/sequence and payload to the
reservation, relays the registered effect, and waits for the registered image workflow's successful `available`
result. Replaying the completion receipt and relay must keep one uploaded event, the same derivative rows and the same
physical objects. The test checks source digest and byte count, derivative metadata/digests/keys, unique variant slots
and the twelve-variant cap.

The population series adds unrelated available media and variants on the other routes of the same partition. The
history series adds retained image-result envelopes, command receipts and write bases without adding current media
rows. Both use scales 256, 1024 and 4096 while the selected Realm route, partition count, input bytes and per-operation
output signature stay fixed. `checkGrowth` supplies the shared physical statement/row/buffer observer and classifier;
the existing Cost bounds remain constant rows, constant statements and logarithmic blocks. The test also requires
non-empty plans, rows and buffer observations at every scale and checks indexed access paths.

## Execution record

This authoring attempt did not run the frozen acceptance, native/browser checks, root check, worker check or remote
check, per the current controller launch instruction. Consequently it has no observed three-scale statement, row or
buffer totals and makes no pass claim. The authored assertions collect and compare those observations when the
controller runs the acceptance command:

```sh
bun run --cwd services/kernel check test/content/growth-realm-asset-publication.test.ts
```

Fixture setup, refused admission, selected registered work, replay and terminal publication are asserted separately;
the acceptance run is still required after integration.
