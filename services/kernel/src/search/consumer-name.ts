import { createHash } from 'node:crypto';

export type SearchConsumerFamily = 'subjects' | 'discovery';

const FAMILY_CODE: { readonly subjects: 's'; readonly discovery: 'd' } = { subjects: 's', discovery: 'd' };
const NATIVE_LIMIT = 63;

/** Exact admitted `KERNEL_SEARCH_PREFIX`: 1–48 `[a-z0-9-]` characters, no final line terminator. */
export function isAdmittedSearchPrefix(prefix: string): boolean {
  if (prefix.length < 1 || prefix.length > 48) return false;
  const matched = /^[a-z0-9][a-z0-9-]{0,47}/.exec(prefix);
  return matched !== null && matched[0] === prefix;
}

function isNativeConsumerName(name: string): boolean {
  if (name.length < 1 || name.length > NATIVE_LIMIT) return false;
  const matched = /^[a-z][a-z0-9_]{0,62}/.exec(name);
  return matched !== null && matched[0] === name;
}

/** Native checkpoint identity for one prefix, generation and family. */
export function searchConsumerName(prefix: string, generation: number, family: SearchConsumerFamily): string {
  if (
    !isAdmittedSearchPrefix(prefix) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    (family !== 'subjects' && family !== 'discovery')
  )
    throw new RangeError('consumer name is invalid');
  const natural = `search_${prefix.replaceAll('-', '_')}${family}_g${generation}`;
  const consumer =
    natural.length <= NATIVE_LIMIT
      ? natural
      : `search_h${createHash('sha256')
          .update(`search-consumer\0${family}\0${prefix}`)
          .digest('hex')
          .slice(0, 32)}${FAMILY_CODE[family]}_g${generation}`;
  if (!isNativeConsumerName(consumer)) throw new RangeError('consumer name is invalid');
  return consumer;
}

export function subjectConsumer(prefix: string, generation: number): string {
  return searchConsumerName(prefix, generation, 'subjects');
}

export function discoveryConsumer(prefix: string, generation: number): string {
  return searchConsumerName(prefix, generation, 'discovery');
}
