import { resolveMediaMetadata } from '../api/media-metadata.ts';
import { ImageRefused, storePublicImage } from '../communities/images.ts';
import { storedImageLabelEditor } from '../document-editor/local-image.ts';
import { type Clearance, nextCheckSeconds, readClearance } from '../safety/upload-state.ts';
import { IMAGE_LIMITS } from './image-file.ts';

// An image becomes showcase art only once screening clears it: Main selects nothing it has not
// cleared, unlike an avatar, which may be selected while it is still being checked. So the editor
// uploads through the shared reserve → bytes → screening protocol and waits for clearance, telling
// the person what screening is doing in the meantime.
//
// `storePublicImage` classifies the image on this device and records the result, which gives an
// unlabelled image its NSFW value. An author who calls the image adult content says so afterwards,
// as the author's own label, which the classification can never overwrite.

export type UploadStage = 'uploading' | 'screening' | 'held';
export type Uploaded =
  | { status: 'cleared'; asset: string }
  /** `held` waits for staff and `slow` for the automatic check after the editor stopped looking; `rejected` will never be shown. */
  | { status: 'refused'; reason: 'rejected' | 'held' | 'slow' | 'limited' | 'failed'; retryAfter?: number };

interface Dependencies {
  store: typeof storePublicImage;
  check: (upload: string) => Promise<Clearance | null>;
  wait: (seconds: number) => Promise<void>;
  /** Labels the stored image NSFW as its author. */
  markAdult: (input: { representation: string; actingSubject: string }) => Promise<void>;
}

async function markAdult({ representation, actingSubject }: { representation: string; actingSubject: string }) {
  const [metadata] = await resolveMediaMetadata([{ representationId: representation }], actingSubject);
  if (!metadata) throw new Error('image-metadata-unavailable');
  if (metadata.nsfw !== 'nsfw') await storedImageLabelEditor(actingSubject)({ metadata, field: 'nsfw', value: 'nsfw', mode: 'edit' });
}
const browser: Dependencies = { store: storePublicImage, check: upload => readClearance(upload), markAdult,
  wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)) };

/** Uploads one image as the acting subject and resolves once it is cleared, refused, or no longer worth waiting for. */
export async function uploadShowcaseImage(input: { file: File; actingSubject: string; key: string;
  /** The author calls the image adult content, whatever the check on their device says. */
  adult?: boolean;
  onStage: (stage: UploadStage) => void; cancelled?: () => boolean }, dependencies: Dependencies = browser): Promise<Uploaded> {
  input.onStage('uploading');
  let stored: Awaited<ReturnType<typeof storePublicImage>>;
  try {
    stored = await dependencies.store({ image: input.file, actingSubject: input.actingSubject, key: input.key,
      maxBytes: IMAGE_LIMITS.bytes });
  } catch (error) {
    if (error instanceof ImageRefused) return { status: 'refused', reason: error.reason, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) };
    return { status: 'refused', reason: 'failed' };
  }
  let clearance = stored.clearance;
  for (let looked = 0; clearance !== 'cleared'; looked += 1) {
    if (clearance === 'rejected') return { status: 'refused', reason: 'rejected' };
    input.onStage(clearance);
    const seconds = nextCheckSeconds(clearance, looked);
    if (seconds === null || input.cancelled?.()) return { status: 'refused', reason: clearance === 'held' ? 'held' : 'slow' };
    await dependencies.wait(seconds);
    clearance = (await dependencies.check(stored.upload)) ?? clearance;
  }
  if (input.adult) {
    try { await dependencies.markAdult({ representation: stored.representation, actingSubject: input.actingSubject }); }
    catch { return { status: 'refused', reason: 'failed' }; }
  }
  return { status: 'cleared', asset: stored.asset };
}
