# Bangumi account-key summary and cover journey

The native caller is `services/kernel/test/imports/bangumi-cli-media-fixture.ts`, consumed by the unchanged
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

Source inspection identifies a conflict in the frozen assertion
`expect(r.cover.original).not.toEqual(r.sourceBytes)`: the content owner contract explicitly retains the original
unchanged for reprocessing and never serves it publicly. See
[`Variants and metadata`](../../../services/kernel/src/content/README.md#variants-and-metadata),
[`processImportedMedia`](../../../services/kernel/src/content/media-import-job.ts) (the exact fetched bytes are
written to `m/{mediaId}/original`) and
[`processImage`](../../../services/kernel/src/content/image-job.ts) (separate deterministic variant writes).
The existing `cover-recovery-pixels.test.ts` and `media-distinct-input.test.ts` assert source/original equality.
The new caller preserves those contracts and independently verifies reencoding on the public variant bytes.
Native verification must identify the first reached failure; source inspection is not a passing native receipt.

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
