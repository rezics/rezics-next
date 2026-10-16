import { createHash } from 'node:crypto';
import type { StagedSourceObservation } from './intake.ts';
import type { MappedSourceValues, MappedSourceConversion } from './mapped-values.ts';
import { SourceConversionInvalid, SourceConversionUnavailable } from './open-library-conversion.ts';

export const BANGUMI_SUBJECT_MAPPING = 'bangumi-subject-map-v1';
const TYPES: Record<number, string> = { 1: 'https://schema.org/Book',
  2: 'https://schema.org/TVSeries', 3: 'https://schema.org/MusicAlbum',
  4: 'https://schema.org/VideoGame', 6: 'https://schema.org/TVSeries' };

/** Subject type codes and tag names are Bangumi meanings, confined to this adapter. */
export function projectBangumiSubject(observation: StagedSourceObservation): {
  values: MappedSourceValues; inventory: MappedSourceConversion['fieldInventory'] } {
  if (observation.provider !== 'bangumi' || observation.namespace !== 'subject'
    || observation.retention !== 'retained' || !observation.rawBytesBase64 || !observation.byteDigest
    || observation.coverage.scope !== 'bangumi-subject-response-v1' || !observation.coverage.complete
    || observation.coverage.omittedFields.length
    || !/^application\/json(?:;|$)/i.test(observation.mediaType)) {
    throw new SourceConversionInvalid('complete retained Bangumi subject is required');
  }
  const bytes = Buffer.from(observation.rawBytesBase64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== observation.byteDigest) {
    throw new SourceConversionUnavailable('source capture digest differs');
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new SourceConversionInvalid('Bangumi subject is not JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceConversionInvalid('Bangumi subject is not an object');
  }
  const body = value as Record<string, unknown>, keys = Object.keys(body);
  if (keys.length > 128 || keys.some(key => !key || key.length > 100)
    || !Number.isSafeInteger(body.id) || String(body.id) !== observation.externalId
    || typeof body.name !== 'string' || !body.name || body.name.length > 500
    || typeof body.type !== 'number' || !TYPES[body.type]) {
    throw new SourceConversionInvalid('Bangumi subject identity or type is invalid');
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
