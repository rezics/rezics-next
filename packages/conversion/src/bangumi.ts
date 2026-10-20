import { ProviderConversionError } from './errors.ts';

const TYPES: Record<number, string> = { 1: 'https://schema.org/Book',
  2: 'https://schema.org/TVSeries', 3: 'https://schema.org/MusicAlbum',
  4: 'https://schema.org/VideoGame', 6: 'https://schema.org/TVSeries' };


/** Pure subject transformation shared by explicit conversion clients. Source
 * custody, rights, native writes and publication are outside this operation. */
export function convertBangumiSubject(externalId: string, body: Record<string, unknown>) {
  const keys = Object.keys(body);
  if (keys.length > 128 || keys.some(key => !key || key.length > 100)
    || !Number.isSafeInteger(body.id) || String(body.id) !== externalId
    || typeof body.name !== 'string' || !body.name || body.name.length > 500
    || typeof body.type !== 'number' || !TYPES[body.type]) {
    throw new ProviderConversionError('record');
  }
  const synopsis = typeof body.summary === 'string' ? body.summary : null;
  const tags = Array.isArray(body.tags) && body.tags.length <= 128
    && body.tags.every(tag => tag && typeof tag === 'object' && !Array.isArray(tag)
      && typeof (tag as { name?: unknown }).name === 'string'
      && (tag as { name: string }).name.length > 0 && (tag as { name: string }).name.length <= 200)
    ? body.tags as Array<{ name: string }> : null;
  const title = { grain: 'subject', field: 'name', pointer: '/name',
    slot: 'work-metadata-v1#title:en', value: body.name };
  return { values: { title, semanticTypes: [TYPES[body.type]!],
    fields: synopsis === null ? [] : [{ grain: 'subject', field: 'summary', pointer: '/summary',
      slot: 'work-editorial-field-v1#synopsis', value: synopsis }],
    children: [{ field: 'tags', grain: 'subject', slot: 'work-native-child-v1#tags',
      values: tags?.map((tag, ordinal) => ({ sourceKey: tag.name, roleKey: null,
        pointer: `/tags/${ordinal}/name`, value: tag.name })) ?? null }],
    sourceOnlyFields: ['summary', 'tags'] },
  inventory: keys.sort().map(field => ({ grain: 'subject', field,
    disposition: ['name', 'type', 'summary', 'tags'].includes(field) ? 'native'
      : field === 'id' ? 'structured-source-only' : 'unsupported',
    ...(!['id', 'name', 'type', 'summary', 'tags'].includes(field) ? { reason: 'undeclared-field' } : {}) })) };
}
