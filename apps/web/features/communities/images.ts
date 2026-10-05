import { BFF_PREFIX } from '../api/browser.ts';
import { recordImageInference } from '../document-editor/record-inference.ts';
import { type Clearance, clearanceOf, limitedFor } from '../safety/upload-state.ts';

const types = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxBytes = 4 * 1024 * 1024;

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** An image Main would not take: a spent upload budget (with when to retry), or an image it rejected. */
export class ImageRefused extends Error {
  constructor(readonly reason: 'limited' | 'rejected', readonly retryAfter?: number) { super(`image-${reason}`); }
}

/** An image stored as a public asset of the acting subject, with screening's first answer. */
export interface StoredImage { asset: string; upload: string; representation: string; clearance: Clearance }

/**
 * The media reserve → bytes → screening protocol, shared by Realm images and a Work's showcase art.
 * An image Main rejected throws; any other clearance is returned for the caller to act on.
 */
export async function storePublicImage(input: { image: File; actingSubject: string; key: string;
  /** Realm icons and banners are avatars, which Main shows up to 4 MiB; other uses may send up to Main's upload limit. */
  maxBytes?: number;
  /** Told what screening said about the image: it shows to its uploader alone until it is `cleared`. */
  onClearance?: (clearance: Clearance) => void }, send: typeof fetch = fetch): Promise<StoredImage> {
  if (!types.has(input.image.type) || input.image.size > (input.maxBytes ?? maxBytes) || !input.image.size) {
    throw new Error('invalid-image');
  }
  const bytes = new Uint8Array(await input.image.arrayBuffer());
  const sha256 = await digest(bytes);
  const reserved = await send(`${BFF_PREFIX}/v1/media/uploads`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:reserve` },
    body: JSON.stringify({ profile: 'media-image-upload-v1', asset: null,
      mediaType: input.image.type, byteLength: bytes.length, sha256,
      disclosure: 'public', actingSubject: input.actingSubject }) });
  const limit = limitedFor(reserved);
  if (limit) throw new ImageRefused('limited', limit.retryAfter);
  if (!reserved.ok) throw new Error('image-reservation-failed');
  const upload = await reserved.json() as { asset: string; upload: string };
  const sent = await send(`${BFF_PREFIX}/v1/media/uploads/${upload.upload}/bytes`, { method: 'PUT',
    headers: { 'content-type': input.image.type }, body: bytes });
  const limited = limitedFor(sent);
  if (limited) throw new ImageRefused('limited', limited.retryAfter);
  const stored = sent.ok ? await sent.json() as { status?: string; clearance?: string; representation?: string } : null;
  if (stored?.status !== 'activated') throw new Error('image-upload-failed');
  const clearance = clearanceOf(stored.clearance);
  input.onClearance?.(clearance);
  // Main will not show an image it rejected, so it is not used anywhere.
  if (clearance === 'rejected') throw new ImageRefused('rejected');
  if (!stored.representation) throw new Error('image-representation-missing');
  await recordImageInference({ ...input, representation: stored.representation, sha256 }, send);
  return { asset: upload.asset, upload: upload.upload, representation: stored.representation, clearance };
}

/** The existing media reserve → bytes → selection protocol for a Realm icon or banner. */
export async function uploadCommunityImage(input: { image: File; realm: string; actingSubject: string;
  kind: 'icon' | 'banner'; key: string;
  /** Told what screening said about the image: it shows to its uploader alone until it is `cleared`. */
  onClearance?: (clearance: Clearance) => void }, send: typeof fetch = fetch): Promise<string> {
  const { asset } = await storePublicImage(input, send);
  const selected = await send(`${BFF_PREFIX}/v1/resources/${input.realm.slice(-36)}/avatar`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:select` },
    body: JSON.stringify({ profile: 'resource-avatar-selection-v1',
      ...(input.kind === 'banner' ? { context: input.realm } : {}),
      expectedSelection: null, asset, actingSubject: input.actingSubject }) });
  if (!selected.ok) throw new Error('image-selection-failed');
  const result = await selected.json() as { selection: string | null };
  if (!result.selection) throw new Error('image-selection-failed');
  return result.selection;
}
