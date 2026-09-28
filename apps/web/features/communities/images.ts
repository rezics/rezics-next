import { BFF_PREFIX } from '../api/browser.ts';

const types = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxBytes = 4 * 1024 * 1024;

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The existing media reserve → bytes → selection protocol for a Realm icon or banner. */
export async function uploadCommunityImage(input: { image: File; realm: string; actingSubject: string;
  kind: 'icon' | 'banner'; key: string }, send: typeof fetch = fetch): Promise<string> {
  if (!types.has(input.image.type) || input.image.size > maxBytes || !input.image.size) {
    throw new Error('invalid-image');
  }
  const bytes = new Uint8Array(await input.image.arrayBuffer());
  const reserved = await send(`${BFF_PREFIX}/v1/media/uploads`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:reserve` },
    body: JSON.stringify({ profile: 'media-image-upload-v1', asset: null,
      mediaType: input.image.type, byteLength: bytes.length, sha256: await digest(bytes),
      disclosure: 'public', actingSubject: input.actingSubject }) });
  if (!reserved.ok) throw new Error('image-reservation-failed');
  const upload = await reserved.json() as { asset: string; upload: string };
  const sent = await send(`${BFF_PREFIX}/v1/media/uploads/${upload.upload}/bytes`, { method: 'PUT',
    headers: { 'content-type': input.image.type }, body: bytes });
  if (!sent.ok || (await sent.json() as { status?: string }).status !== 'activated') {
    throw new Error('image-upload-failed');
  }
  const selected = await send(`${BFF_PREFIX}/v1/resources/${input.realm.slice(-36)}/avatar`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': `${input.key}:select` },
    body: JSON.stringify({ profile: 'resource-avatar-selection-v1',
      ...(input.kind === 'banner' ? { context: input.realm } : {}),
      expectedSelection: null, asset: upload.asset, actingSubject: input.actingSubject }) });
  if (!selected.ok) throw new Error('image-selection-failed');
  const result = await selected.json() as { selection: string | null };
  if (!result.selection) throw new Error('image-selection-failed');
  return result.selection;
}
