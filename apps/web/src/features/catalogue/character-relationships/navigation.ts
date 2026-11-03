import { subjectHref } from '../../../subject/subject-href';
import { characterUuid } from '../character-profile';
import type { CharacterRelationshipsAddress } from './reading';

export function characterRelationshipsHref(
  address: { id: string; label: string; locale: string } & Partial<CharacterRelationshipsAddress>,
): string {
  const query = new URLSearchParams();
  if (address.stream) query.set('stream', address.stream);
  if (address.cursor) query.set('cursor', address.cursor);
  if (address.work) query.set('work', address.work);
  const suffix = query.size ? `?${query}` : '';
  return `${subjectHref({ id: address.id, label: address.label }, address.locale).href}/character-relationships${suffix}`;
}

export function characterRelationshipsReturn(address: CharacterRelationshipsAddress & { label: string; locale: string }): string {
  return characterRelationshipsHref(address);
}

export function parseCharacterRelationshipsAddress(input: {
  id: string;
  stream?: unknown;
  cursor?: unknown;
  work?: unknown;
}): CharacterRelationshipsAddress | undefined {
  if (!characterUuid.test(input.id)) return undefined;
  const stream = typeof input.stream === 'string' && input.stream.length > 0 && input.stream.length <= 256 ? input.stream : undefined;
  const cursor =
    typeof input.cursor === 'string' && input.cursor.length > 0 && input.cursor.length <= 8192 ? input.cursor : undefined;
  const work = typeof input.work === 'string' && characterUuid.test(input.work) ? input.work : undefined;
  if (cursor && !stream) return undefined;
  return { id: input.id, ...(stream ? { stream } : {}), ...(cursor ? { cursor } : {}), ...(work ? { work } : {}) };
}

/** Changing character, work, stream or release identity retires the previous rows before a new read. */
export function associationReadingKey(address: CharacterRelationshipsAddress, generation: number, release?: string): string {
  return JSON.stringify([address.id, address.stream ?? '', address.cursor ?? '', address.work ?? '', generation, release ?? '']);
}
