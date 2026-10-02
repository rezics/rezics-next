import type { PoolClient } from 'pg';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';

export class DocumentMediaInvalid extends Error {}
interface ImageUse { use: string; representation: string; occurrence: string; conceal: boolean }
const uuid = /^[0-9a-f-]{36}$/;
function managedUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value, 'https://rezics.com');
    return /^(?:[a-z0-9-]+\.)*rezics\.com$|^(?:localhost|127\.0\.0\.1)$/i.test(url.hostname)
      && /^(?:\/api\/main)?\/v1\/media\//.test(url.pathname);
  } catch { return false; }
}

/** Walk only the already validated document nodes. Never follow another content reference. */
export function documentImageUses(document: DocumentSnapshot | undefined): ImageUse[] {
  if (!document) return [];
  const uses: ImageUse[] = [];
  const pending: DocumentNode[] = [document.doc];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image') {
      const attrs = node.attrs ?? {};
      if (attrs.representationId != null || attrs.mediaUseId != null || managedUrl(attrs.src)) {
        if (![attrs.mediaUseId, attrs.representationId, attrs.id].every(value => typeof value === 'string' && uuid.test(value)))
          throw new DocumentMediaInvalid('stored images require an exact representation, use and occurrence');
        uses.push({ use: attrs.mediaUseId as string, representation: attrs.representationId as string,
          occurrence: attrs.id as string, conceal: attrs.conceal === true });
      }
    }
    pending.push(...node.content ?? []);
  }
  return uses;
}

/** The same Use row serializes a first protection write and a whole-document save. */
export async function guardDocumentImageUses(client: Pick<PoolClient, 'query'>, uses: readonly ImageUse[],
  targets: readonly string[], priorUses: readonly ImageUse[] = []): Promise<void> {
  const prior = new Map(priorUses.map(item => [item.use, item]));
  for (let offset = 0; offset < uses.length; offset += 64) {
    const batch = uses.slice(offset, offset + 64);
    const ids = [...new Set(batch.map(item => item.use))].sort();
    const rows = (await client.query<{ id: string; representation_id: string; target: string; occurrence: string; role: string }>(
      `SELECT id, representation_id, target, occurrence, role FROM media.use
        WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, [ids])).rows;
    const available = new Map(rows.map(row => [row.id, row]));
    if (batch.some(item => {
      const row = available.get(item.use);
      return !row || row.role !== 'document-image' || row.representation_id !== item.representation
        || row.occurrence !== item.occurrence || !targets.includes(row.target);
    })) throw new DocumentMediaInvalid('document image use does not match its representation, occurrence or target');
    const controls = (await client.query<{ use_id: string; protection_head: string | null; value: unknown }>(
      `SELECT s.use_id, s.protection_head, v.value FROM media.field_slot s
        LEFT JOIN media.field_revision v ON v.id = s.value_head
        WHERE s.use_id = ANY($1::uuid[]) AND s.field = 'conceal'
        ORDER BY s.slot FOR SHARE OF s`, [ids])).rows;
    const byUse = new Map(controls.map(row => [row.use_id, row]));
    for (const item of batch) {
      const before = prior.get(item.use);
      // A retained fallback can outlive a platform correction. Saving unrelated
      // text preserves it; changing the field must use the current owner value.
      if (before && before.occurrence === item.occurrence && before.conceal === item.conceal) continue;
      const control = byUse.get(item.use);
      if ((control?.value ?? false) === item.conceal) continue;
      if (control?.protection_head) throw new DocumentMediaInvalid('document image concealment is locked');
      throw new DocumentMediaInvalid('update the image Use concealment before saving its changed snapshot');
    }
  }
}
