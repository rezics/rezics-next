# Empty media collection growth binding

This native binding adds the two collection costs missing from the [media cost map](content-quality-media.md): an
initially empty eligible selection and the terminal empty page after a full bounded batch. It uses the existing
content Cost contract in `services/kernel/src/content/README.md`; the worker batch remains 100, with 16 exact routes
per partition and one configured partition in each scheduled run.

## Operation boundary

| Phase      | Binding                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup      | `createContentSystem`, `provisionMediaContainers`, and the existing `media-native-collection-fixture.ts`; make one old actively claimed media item and one fresh item through HTTP, isolated storage, registered upload effects, and Sharp. Seed unrelated same-route and other-route media, variants, reservation receipts, reserved events, and write-basis rows outside the observation. |
| Selection  | Trigger the registered `content.collection.hourly` schedule with the same one-partition configuration. The empty case returns one `content.collect.step` outcome with `examined: 0`, `collected: 0`, and `complete: true`. The terminal case first returns a full 100-item page, then a separate `0`-item complete page.                                                                    |
| Completion | For the empty case, the claimed and fresh rows and every stored object remain byte-for-byte represented by their original keys and digests; neither collection receipts nor collection events appear. For the full page, the selected 100 rows and prefixes are removed and each target has its expected fence/finish receipts and collection events.                                       |
| Replay     | Read the completed registered workflow again and assert the same result and recorded steps. This confirms workflow-result replay without scheduling a second collection operation or inventing a media completion receipt.                                                                                                                                                                  |

Each growth report observes the actual registered schedule and its worker pool. The empty-selection report supplies
the fixed scheduling plus empty-page baseline. The terminal report records the full-page and terminal-page outcomes
under the same scheduling configuration. Setup and seeded history stay outside capture. Rows, statements, buffer
work, access paths, workflow IDs, page outcomes, and scale populations are written to
`.temp/goal/content-empty-media-collection-growth.json` by the acceptance test.

## Cost

### Initially empty eligible selection

- Touches: The registered hourly parent and one configured partition workflow; the collector reads authoritative time
  and visits the partition's 16 exact routes and their two limited selection branches. It returns an empty page without
  collection commands, collection receipts, or storage deletion.
- Bound: One scheduled partition, 16 route visits, and the existing two-branch page bound. Rows and statements stay
  constant; buffer blocks grow logarithmically with same-route and other-route retained history.
- Growth check: `test/content/growth-media-empty-collection.test.ts`, same-route and other-route series at 256, 1024,
  and 4096; the other-route series holds 4096 same-route rows fixed. Each sample has two repetitions and captures the
  registered `content.collect.step` result.

### Terminal empty page after a full batch

- Touches: The same registered parent and partition workflow; one page examines 100 real HTTP-produced media targets,
  then a second page returns empty. The full page has at most 3,200 branch candidates, 300 buffered candidates, 200
  sequential command phases, and 100 sequential storage prefix deletions under the owning `COLLECTION_BOUNDS`.
- Bound: Page size remains 100 and scheduled partitions remain one. Rows and statements stay constant at the fixed
  page size; buffer blocks grow logarithmically with the named retained histories. The following terminal page adds no
  media command or storage deletion.
- Growth check: `test/content/growth-media-empty-collection.test.ts`, same-route and other-route series at 256, 1024,
  and 4096; the other-route series holds 4096 same-route rows fixed. Each measured repetition creates one real
  100-media batch outside capture and asserts both registered page results.

## Growth shape and limits

Both operations grow the same-route history at 256, 1024, and 4096. Separate series hold 4096 same-route rows fixed
while growing other-route history at those same scales. The selected partition, target route/container, and number of
scheduled partitions stay fixed. Seeded rows are fresh at the worker cutoff and have retained variant, receipt,
outbox, and write-basis history; they contribute no eligible targets. The fixed claimed and fresh HTTP targets remain
the lifecycle controls across every scale.

The reports use constant row and statement bounds and logarithmic buffer-block growth, with the shared growth
observer and access-path assertions. The test preserves the owning `COLLECTION_BOUNDS.batch` value and performs
actual native media upload, completion, event relay, image publication, scheduled collection, and isolated object
deletion. The binding establishes isolated-resource behavior only; it does not establish a live provider setup.

The controller defers execution of this native acceptance until integration. The test artifact records the revision,
command, fixtures, reached assertions, scale observations, and this execution limit when the frozen check runs.
