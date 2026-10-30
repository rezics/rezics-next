# Bangumi account-key summary and cover journey

The native caller is `services/kernel/test/imports/bangumi-cli-media-fixture.ts`, consumed by the owning frozen
`Bangumi licensed summary and cover CLI lifecycle` acceptance. It calls production `runImportCli` for the pinned
subject 424242, using `bangumi@3` and the native unversioned entry revision. One `openApiRuntime` owns Auth,
Access, the application and the registered media worker. The operator key is staged, approved and applied through
Auth, then written mode 0600 on tmpfs alongside the private SQLite journal. Only stdin, fetch and the documented
observer boundary are supplied to the CLI; no resolver or native response is replaced.

The caller observes actual seal results before allowing Auth or public effects. It routes Auth to its host handler
and ordinary public requests to the kernel. A committed media reservation permits one bounded registered worker
drain before the CLI's actual import-status request. Two separately supplied red/blue PNGs exercise distinct
stored source bytes, generated AVIF/WebP variants and public download authorization. Normal editor routes accept
and adopt the real summary and cover candidates. A separately proposed/adopted community name survives refresh.
An exact cover tuple fence hides both old and refreshed cover disclosures and downloads, while unchanged,
changed-URL and reopened CLI input cannot reserve or attach a cover. Summary visibility and its own takedown are
observed independently. Immutable original bootstrap journal bytes and native receipt responses are retained.

The local `services/importer/tests/bangumi-cli-media.test.ts` case exercises the CLI's real resolver and transport
against a protocol double, including independent rights, refresh and a late fence. This is a local wire proof;
it makes no claim about native authorization, job execution or persisted pixels.

## Original bytes and published variants

The fixture returns `cover` and `refreshedCover` directly from the existing `mediaBoundary.observe` export. Its
`original` field is the actual privately stored source object, and `sourceBytes` is the actual supplied first PNG.
It does not substitute a variant for that object or substitute dump text for the source image.

The content owner contract retains the original unchanged for reprocessing and never serves it publicly. See
[`Variants and metadata`](../../../services/kernel/src/content/README.md#variants-and-metadata),
[`processImportedMedia`](../../../services/kernel/src/content/media-import-job.ts) (the exact fetched bytes are
written to `m/{mediaId}/original`) and
[`processImage`](../../../services/kernel/src/content/image-job.ts) (separate deterministic variant writes).
The existing `cover-recovery-pixels.test.ts` and `media-distinct-input.test.ts` assert source/original equality.
The caller preserves those contracts and independently verifies reencoding on the public variant bytes. The
owning frozen oracle now requires original/source equality and separately checks that each actual AVIF/WebP
variant differs from the supplied PNG. Original retention and public byte safety are separate observations.

## Historical native observation

The managed acceptance at code revision `7866d4137d` completed the fixture and then failed the frozen original-byte
inequality at `bangumi-cli-media.test.ts:15`, with 566 assertions executed. It is not a native acceptance pass.
The actual original and supplied SHA-256 values match for both admitted images:

- Red: `18d3228bdfacca8431a92d7b7e9eaf8d5cd28ac2e4d5f4e732c13ac974f0b905`.
- Blue: `80642985ef55e449db5ef812e1635ee6893cb2ca83b68e4d743fd9bed565217c`.

The observed subject was `01a18be7-6fd1-7590-a44e-b7ae9b34fad0`; its two media IDs were
`01a18be7-703c-77cf-9dc6-b7ae0c63777c` and `01a18be7-755b-767f-8f5a-b7ae1f65c14a`.
The worker executed exactly two `content.importFromUrl` children and two `content.image` children. Their actual
effect anchors were epoch 1, partition 2938, positions 2/3 and 17/18, event index 0. Sixteen native write receipt
identities were observed, including the bootstrap `subject.batch_create` receipt at partition 2938, account
`764ada75-62ac-8c41-a37c-a3c38c0cfe2a`, key
`bangumi:424242:333c04dd151a2a6831c039cb9a651df29198be8a04e16ce861d4b6a34a11c954`.

The converter stayed `bangumi@3`, the record revision stayed `unversioned`, and the bundle was
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`. The three actual source digests were
`5fc1248acf2e21f5b213b4adf9045b585dd82a63263da1eb543cd2eabab01705`,
`3f0986d0fd897aa0f606605381b116c14b47812e28b9ae4c026dac756c6f5631` and
`f00f0dd5624c21639b953189590a0e18c76e185b79e1eea3947c6f24352e001c`.

The first native setup attempt exposed a fixture document-reference mistake, corrected to consume the actual
`document` reference. The next attempt reached a genuine subject-read disclosure defect: the independently built
cover summary survived a source takedown. The adopted point-read repair is
`services/kernel/src/semantic/subject.ts`: one exact media probe and an independently anchored exact source-fence
read suppress that selected cover's metadata. The final journey observed no disclosed cover after the fence,
denied both old and refreshed variant downloads, preserved independent metadata and bootstrap bytes/receipts,
and independently fenced the licensed summary. It does not extend the other discovery readers.

The earlier byte-inequality result remains a failure against its original oracle. The corrected owning oracle
requires a fresh focused native execution; neither the historical completed fixture nor this documentation
relabels that result as a pass. The point-read repair checks the source fence only when an imported reference
exists. A null imported reference adds no suppression policy for other supported media kinds; the common
projection and its existing readers retain their contracts.

## Bounds and evidence

- Touches: supplied JSONL and two source images, the exact source/key/run journal, captured public requests,
  their command keys and native receipts, and the selected subject/document/media anchors.
- Bound: existing dump, projection, command, media and transport ceilings. The fixture supplies one record,
  two images and at most one bounded drain per captured reservation, with `maxJobs: 16`. No catalogue/history
  scan, shared harness extension or PostgreSQL work estimator is introduced.
- Growth check: existing source/reader/coordinator/transport bounds remain unchanged. New native growth
  evidence is missing; this connected caller is not a replacement for the shared growth series.

The native log emits the actual bundle digest, converter and record revision, source digests, subject/media IDs,
registered child workflow names and counts, receipt anchors, and supplied/stored original hashes. Check status,
tested Git revision and the first reached failure belong in the attempt handoff. No external reference
implementation was needed: the surface consumes the existing repository exports listed above, plus
`identitySupport` and `openApiObserver`; it does not depend on another new slice's fixture helper.
