import { BFF_PREFIX } from '../api/browser.ts';
import { recordImageInference } from '../document-editor/record-inference.ts';
import { type Clearance, clearanceOf, limitedFor } from '../safety/upload-state.ts';

// A Work's cover is its avatar selection: an image the writer uploads as a
// public media asset (reserve, then send the bytes), then selects for the
// Work. Studio crops and scales the image in the browser first, because Main
// stores a crop without applying it and shows covers of at most 2048 px and
// 4 MiB. Raw bytes cannot go through the typed client, so this module speaks
// HTTP through the BFF directly.

/** The largest cover Studio sends: Main shows covers up to 2048 px a side and 4 MiB. */
export const COVER_MAX_BYTES = 4 * 1024 * 1024;
export const coverTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * `done` means the cover is selected, not that anyone can see it: a new image
 * is `screening` (or `held` for review) and shows to its uploader alone until
 * Main clears it. `clearance` is null where no image was sent (removal).
 */
export type CoverOutcome =
  | { outcome: 'done'; selection: string | null; upload: string | null; clearance: Clearance | null }
  | { outcome: 'limited'; retryAfter: number }
  | { outcome: 'denied' | 'too-large' | 'unsupported' | 'rejected' | 'failed' };
type Refused = Exclude<CoverOutcome, { outcome: 'done' }>;
type Selected = { outcome: 'done'; selection: string | null } | Refused;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const refusal = (response: Response): Refused => {
  const limited = limitedFor(response);
  const { status } = response;
  return limited ? { outcome: 'limited', ...limited }
    : { outcome: status === 401 || status === 403 ? 'denied' : status === 413 ? 'too-large'
      : status === 422 || status === 400 ? 'unsupported' : 'failed' };
};

async function json<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

/**
 * Selects `asset` (null removes the cover) on the selection the writer saw.
 * The selection may have moved (another tab, or a head Main hides); Main then
 * names the current one, and the writer's explicit choice is made on it.
 */
async function select(input: { actingSubject: string; work: string; asset: string | null; expected: string | null;
  key: string }, send: typeof fetch): Promise<Selected> {
  let expected = input.expected;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await send(`${BFF_PREFIX}/v1/resources/${input.work.slice(-36)}/avatar`, { method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:select:${expected ?? 'none'}` },
      body: JSON.stringify({ profile: 'resource-avatar-selection-v1', expectedSelection: expected, asset: input.asset,
        actingSubject: input.actingSubject }) });
    if (response.ok) return { outcome: 'done', selection: (await json<{ selection: string | null }>(response))?.selection ?? null };
    const problem = await json<{ code?: string; current?: string | null }>(response.clone());
    if (response.status !== 409 || problem?.code !== 'stale_head' || problem.current === undefined) {
      return refusal(response);
    }
    expected = problem.current;
  }
  return { outcome: 'failed' };
}

/** Uploads a prepared cover image as a public asset of the Studio Agent and makes it the Work's cover. */
export async function uploadCover(input: { actingSubject: string; work: string; image: Blob; expected: string | null;
  key: string }, send: typeof fetch = fetch): Promise<CoverOutcome> {
  if (!(coverTypes as readonly string[]).includes(input.image.type)) return { outcome: 'unsupported' };
  if (input.image.size > COVER_MAX_BYTES) return { outcome: 'too-large' };
  try {
    const bytes = new Uint8Array(await input.image.arrayBuffer());
    const byteDigest = await sha256(bytes);
    const reserved = await send(`${BFF_PREFIX}/v1/media/uploads`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:reserve` },
      body: JSON.stringify({ profile: 'media-image-upload-v1', asset: null, mediaType: input.image.type,
        byteLength: bytes.length, sha256: byteDigest, disclosure: 'public', actingSubject: input.actingSubject }) });
    if (!reserved.ok) return refusal(reserved);
    const upload = await json<{ asset: string; upload: string }>(reserved);
    if (!upload) return { outcome: 'failed' };
    const sent = await send(`${BFF_PREFIX}/v1/media/uploads/${upload.upload}/bytes`, { method: 'PUT',
      headers: { 'content-type': input.image.type }, body: bytes });
    if (!sent.ok) return refusal(sent);
    const stored = await json<{ status?: string; clearance?: string; representation?: string }>(sent);
    if (stored?.status !== 'activated') return { outcome: 'unsupported' };
    const clearance = clearanceOf(stored.clearance);
    // Main will not show an image it rejected, so it is not made the cover.
    if (clearance === 'rejected') return { outcome: 'rejected' };
    if (!stored.representation) return { outcome: 'failed' };
    await recordImageInference({ ...input, representation: stored.representation, sha256: byteDigest }, send);
    const selected = await select({ ...input, asset: upload.asset }, send);
    return selected.outcome === 'done' ? { ...selected, upload: upload.upload, clearance } : selected;
  } catch {
    return { outcome: 'failed' };
  }
}

/** Removes the Work's cover image; readers see the generated cover again. */
export async function removeCover(input: { actingSubject: string; work: string; expected: string | null; key: string },
  send: typeof fetch = fetch): Promise<CoverOutcome> {
  try {
    const selected = await select({ ...input, asset: null }, send);
    return selected.outcome === 'done' ? { ...selected, upload: null, clearance: null } : selected;
  } catch { return { outcome: 'failed' }; }
}
