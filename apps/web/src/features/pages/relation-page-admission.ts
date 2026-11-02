import type { PageRead } from '@rezics/composition';
import { relationItemRows } from './relation-item-identity';

export type RelationPageAdmission = { ok: true } | { ok: false; reason: 'malformed' | 'over-limit' };

type RelationSection =
  | { ok: false; status?: number | undefined }
  | { ok: true; read: PageRead; body: Record<string, unknown> };

/** Admit the complete native page against the composition producer bound before projection. */
export function admitRelationPage(section: RelationSection | undefined): RelationPageAdmission {
  if (!section?.ok) return { ok: false, reason: 'malformed' };
  const { read } = section;
  if (read.kind !== 'links' && read.kind !== 'relations') return { ok: false, reason: 'malformed' };
  const rows = relationItemRows(section.body[read.kind], read.kind);
  if (!rows) return { ok: false, reason: 'malformed' };
  return rows.length > read.limit ? { ok: false, reason: 'over-limit' } : { ok: true };
}
