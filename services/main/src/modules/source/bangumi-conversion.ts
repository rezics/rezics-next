import { convertBangumiSubject, ProviderConversionError } from '../../../../../packages/conversion/src/index.ts';
import { createHash } from 'node:crypto';
import type { StagedSourceObservation } from './intake.ts';
import type { MappedSourceValues, MappedSourceConversion } from './mapped-values.ts';
import { SourceConversionInvalid, SourceConversionUnavailable } from './open-library-conversion.ts';

export const BANGUMI_SUBJECT_MAPPING = 'bangumi-subject-map-v1';
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
  try { return convertBangumiSubject(observation.externalId,value as Record<string, unknown>); }
  catch (error) {
    if (error instanceof ProviderConversionError) throw new SourceConversionInvalid('Bangumi subject identity or type is invalid');
    throw error;
  }
}
