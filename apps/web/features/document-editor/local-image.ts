import type { ImageUploader } from '@rezics/ui/editor-image';
import type { ImageLabelEditor } from '@rezics/ui/editor-image-view';
import { ImageLabelEditError } from '@rezics/ui/image-settings';
import { BFF_PREFIX } from '../api/browser.ts';
import { resolveMediaMetadata } from '../api/media-metadata.ts';
import { recordImageInference } from './record-inference.ts';

/** Authenticated reserve → bytes → client evidence → stable occurrence Use. No blob address is saved. */
export function storedImageUpload(actingSubject: string, target: string, send: typeof fetch = fetch): ImageUploader {
  return async (file, occurrence) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(file.type)
      || !file.size || file.size > 8 * 1024 * 1024) throw new Error('invalid-image');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const key = crypto.randomUUID();
    const jsonHeaders = { 'content-type': 'application/json' };
    const reserved = await send(`${BFF_PREFIX}/v1/media/uploads`, { method: 'POST',
      headers: { ...jsonHeaders, 'idempotency-key': `${key}:reserve` },
      body: JSON.stringify({ profile: 'media-image-upload-v1', asset: null, actingSubject, mediaType: file.type,
        byteLength: bytes.length, sha256, disclosure: 'public' }) });
    if (!reserved.ok) throw new Error('image-reservation-failed');
    const upload = await reserved.json() as { upload: string };
    const sent = await send(`${BFF_PREFIX}/v1/media/uploads/${upload.upload}/bytes`, { method: 'PUT',
      headers: { 'content-type': file.type }, body: bytes });
    if (!sent.ok) throw new Error('image-upload-failed');
    const stored = await sent.json() as { status: string; representation: string | null };
    if (stored.status !== 'activated' || !stored.representation) throw new Error('image-upload-failed');
    await recordImageInference({ image: file, sha256, representation: stored.representation, actingSubject, key }, send);
    const linked = await send(`${BFF_PREFIX}/v1/media/uses`, { method: 'POST',
      headers: { ...jsonHeaders, 'idempotency-key': `${key}:use` },
      body: JSON.stringify({ actingSubject, target, representation: stored.representation, occurrence, conceal: false }) });
    if (!linked.ok) throw new Error('image-reference-failed');
    const use = await linked.json() as { use: string };
    return { src: `${BFF_PREFIX}/v1/media/representations/${stored.representation}/bytes?use=${encodeURIComponent(use.use)}`,
      representationId: stored.representation, mediaUseId: use.use };
  };
}

/** Every label and protection mutation uses the current owner value and protection heads. */
export function storedImageLabelEditor(actingSubject: string, send: typeof fetch = fetch): ImageLabelEditor {
  return async ({ metadata, field, value, mode }) => {
    const control = metadata.controls?.[field];
    if (!control || field === 'conceal' && !metadata.mediaUseId) throw new Error('image-control-unavailable');
    const path = field === 'conceal' ? `/v1/media/uses/${metadata.mediaUseId}/conceal`
      : `/v1/media/representations/${metadata.representationId}/labels`;
    const response = await send(`${BFF_PREFIX}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ actingSubject, ...(field === 'conceal' ? {} : { field }),
        expectedValueHead: control.valueHead, basis: control.basis, value, mode,
        authority: control.canProtect ? 'platform' : 'author' }) });
    if (!response.ok) {
      const current = response.status === 409 || response.status === 403
        ? (await resolveMediaMetadata([metadata], actingSubject, send).catch(() => []))[0] : undefined;
      throw new ImageLabelEditError(current ? { ...current, requestKey: metadata.requestKey } : undefined);
    }
    const updated = (await resolveMediaMetadata([metadata], actingSubject, send))[0];
    if (!updated) throw new Error('image-metadata-unavailable');
    return { ...updated, requestKey: metadata.requestKey };
  };
}
