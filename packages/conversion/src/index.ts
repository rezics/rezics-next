import { ProviderConversionError } from './errors.ts';
export { ProviderConversionError } from './errors.ts';
export { convertBangumiSubject } from './bangumi.ts';

/** Input coordinates describe a provider record, never native authority or adoption. */
export interface ProviderRecordIdentity {
  key: string; provider: string; namespace: string; externalId: string;
}
const rowObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Existing bare-response normalization. No acquisition, custody, database or
 * native write runs here. Bangumi enrichment requires the retained envelope;
 * unsupported shapes are never invented by this converter. */
export function convertProviderRecord(identity: ProviderRecordIdentity, data: Record<string, unknown>) {
  const { provider, namespace: kind, externalId } = identity;
  if (String(data.id) !== externalId) throw new ProviderConversionError('record');
  if (provider === 'musicbrainz') {
    const text = rowObject(data['text-representation']);
    return { key: identity.key, provider: 'musicbrainz' as const, kind, externalId,
      title: typeof data.title === 'string' ? data.title : typeof data.name === 'string' ? data.name : `${kind} ${externalId}`,
      language: typeof text?.language === 'string' ? text.language : 'und',
      sourceUrl: `https://musicbrainz.org/${kind}/${externalId}`, data,
      native: ['release-group', 'recording', 'work'].includes(kind) ? 'work' as const : kind === 'release' ? 'release' as const
        : kind === 'artist' ? data.type === 'Person' ? 'person' as const : 'organization' as const : 'source-only' as const,
      ...(['release-group', 'recording'].includes(kind) ? { semanticTypes: [kind === 'release-group'
        ? 'https://schema.org/MusicAlbum' : 'https://schema.org/MusicRecording'] } : {}) };
  }
  if (provider === 'vndb') {
    const native = ({ vn: 'work', release: 'release', character: 'character', staff: 'person',
      producer: 'organization', tag: 'concept', trait: 'concept' } as const)[kind as 'vn'];
    if (!native) throw new ProviderConversionError('unsupported');
    return { key: identity.key, provider: 'vndb' as const, kind, externalId, title: String(data.name ?? externalId),
      language: String(data.olang ?? data.lang ?? 'und'), sourceUrl: `https://vndb.org/${externalId}`,
      data, native, ...(kind === 'vn' ? { semanticTypes: ['https://schema.org/VideoGame'] } : {}) };
  }
  // Bangumi archive enrichment has additional fields and omission rules. Only
  // the exact retained DatasetRecord envelope can certify that combined record.
  throw new ProviderConversionError('unsupported');
}
