import type { PageRead } from '@rezics/composition';
import { relationItemRows } from './relation-item-identity';

export type RelationPageAdmission = { ok: true } | { ok: false; reason: 'malformed' | 'over-limit' };

type RelationSection =
  | { ok: false; status?: number | undefined }
  | { ok: true; read: PageRead; body: Record<string, unknown> };

/** Admit the complete native page against the composition producer bound before projection. */
export function admitRelationPage(section: RelationSection | undefined): RelationPageAdmission {
  if (!section?.ok) return { ok: false, reason: 'malformed' };
  const { kind, limit } = section.read;
  if ((kind !== 'links' && kind !== 'relations') || typeof limit !== 'number')
    return { ok: false, reason: 'malformed' };
  const rows = relationItemRows(section.body[kind], kind);
  if (!rows) return { ok: false, reason: 'malformed' };
  return rows.length > limit ? { ok: false, reason: 'over-limit' } : { ok: true };
}
