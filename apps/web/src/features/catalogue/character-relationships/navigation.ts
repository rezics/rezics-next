import { subjectHref } from '../../../subject/subject-href';
import { characterUuid } from '../character-profile';
import type { CharacterRelationshipsAddress } from './reading';

export type CharacterRelationshipsOrigin = CharacterRelationshipsAddress & {
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
};

export type CharacterRelationshipsFocus = { holder: string; statement: string };

export type CharacterRelationshipsVisit = {
  version: 1;
  origin: string;
  context: string | null;
  realm: string | null;
  stream: string | null;
  work: string | null;
  cursors: (string | null)[];
  index: number;
  focus?: CharacterRelationshipsFocus | undefined;
};

export const CHARACTER_RELATIONSHIPS_CURSOR_LIMIT = 8;
const visitStateKey = 'characterRelationshipsVisit';
const visitStateByteLimit = 327_680;

function originKey(origin: CharacterRelationshipsOrigin): string | undefined {
  if (
    !characterUuid.test(origin.id) ||
    !/^[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(origin.locale) ||
    (origin.context !== undefined && !characterUuid.test(origin.context)) ||
    (origin.realm !== undefined && !characterUuid.test(origin.realm)) ||
    (origin.stream !== undefined && (!origin.stream.length || origin.stream.length > 256)) ||
    (origin.cursor !== undefined && (!origin.cursor.length || origin.cursor.length > 8192)) ||
    (origin.work !== undefined && !characterUuid.test(origin.work))
  )
    return;
  return JSON.stringify([
    origin.id,
    origin.locale,
    origin.context ?? '',
    origin.realm ?? '',
    origin.stream ?? '',
    origin.cursor ?? '',
    origin.work ?? '',
  ]);
}

function boundedCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** A return address keeps at most eight opaque native cursors and exact row identity, never reader payloads. */
export function characterRelationshipsVisit(
  value: unknown,
  origin: CharacterRelationshipsOrigin,
): CharacterRelationshipsVisit | undefined {
  const key = originKey(origin);
  if (!key || !value || typeof value !== 'object') return;
  const nested = Reflect.get(value, visitStateKey);
  const candidate = nested && typeof nested === 'object' ? nested : value;
  const cursors = Reflect.get(candidate, 'cursors');
  const index = Reflect.get(candidate, 'index');
  const stream = Reflect.get(candidate, 'stream');
  const work = Reflect.get(candidate, 'work');
  const focus = Reflect.get(candidate, 'focus');
  if (
    Reflect.get(candidate, 'version') !== 1 ||
    Reflect.get(candidate, 'origin') !== key ||
    Reflect.get(candidate, 'context') !== (origin.context ?? null) ||
    Reflect.get(candidate, 'realm') !== (origin.realm ?? null) ||
    (stream !== null && (typeof stream !== 'string' || !stream.length || stream.length > 256)) ||
    (work !== null && (typeof work !== 'string' || !characterUuid.test(work))) ||
    !Array.isArray(cursors) ||
    cursors.length < 1 ||
    cursors.length > CHARACTER_RELATIONSHIPS_CURSOR_LIMIT ||
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    (index as number) >= cursors.length ||
    cursors.some((cursor, at) => (cursor === null ? at !== 0 : !boundedCursor(cursor))) ||
    (focus !== undefined &&
      (!focus ||
        typeof focus !== 'object' ||
        !characterUuid.test(String(Reflect.get(focus, 'holder') ?? '')) ||
        !characterUuid.test(String(Reflect.get(focus, 'statement') ?? ''))))
  )
    return;
  const accepted: CharacterRelationshipsVisit = {
    version: 1,
    origin: key,
    context: origin.context ?? null,
    realm: origin.realm ?? null,
    stream: stream as string | null,
    work: work as string | null,
    cursors: cursors as (string | null)[],
    index: index as number,
    ...(focus
      ? {
          focus: {
            holder: Reflect.get(focus, 'holder') as string,
            statement: Reflect.get(focus, 'statement') as string,
          },
        }
      : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(accepted)).byteLength > visitStateByteLimit) return;
  return accepted;
}

export function createCharacterRelationshipsVisit(
  origin: CharacterRelationshipsOrigin,
  address: {
    stream?: string | undefined;
    work?: string | undefined;
    cursors: readonly (string | null)[];
    index: number;
    focus?: CharacterRelationshipsFocus | undefined;
  },
): CharacterRelationshipsVisit | undefined {
  const key = originKey(origin);
  if (!key) return;
  return characterRelationshipsVisit(
    {
      version: 1,
      origin: key,
      context: origin.context ?? null,
      realm: origin.realm ?? null,
      stream: address.stream ?? null,
      work: address.work ?? null,
      cursors: [...address.cursors],
      index: address.index,
      ...(address.focus ? { focus: address.focus } : {}),
    },
    origin,
  );
}

/** Move forward within retained addresses, trimming older pages at the eight-address bound. */
export function advanceCharacterRelationshipsCursor(
  current: readonly (string | null)[],
  index: number,
  next: string,
): { cursors: (string | null)[]; index: number } {
  if (current[index + 1] === next) return { cursors: [...current], index: index + 1 };
  const cursors = [...current.slice(0, index + 1), next];
  if (cursors.length > CHARACTER_RELATIONSHIPS_CURSOR_LIMIT)
    cursors.splice(0, cursors.length - CHARACTER_RELATIONSHIPS_CURSOR_LIMIT);
  return { cursors, index: cursors.length - 1 };
}

export function characterRelationshipsHref(
  address: {
    id: string;
    label: string;
    locale: string;
    context?: string | undefined;
    realm?: string | undefined;
  } & Partial<CharacterRelationshipsAddress>,
): string {
  const query = new URLSearchParams();
  if (address.context) query.set('context', address.context);
  if (address.realm) query.set('realm', address.realm);
  if (address.stream) query.set('stream', address.stream);
  if (address.cursor) query.set('cursor', address.cursor);
  if (address.work) query.set('work', address.work);
  const suffix = query.size ? `?${query}` : '';
  return `${subjectHref({ id: address.id, label: address.label }, address.locale).href}/character-relationships${suffix}`;
}

export function characterRelationshipsReturn(
  address: CharacterRelationshipsAddress & { label: string; locale: string },
): string {
  return characterRelationshipsHref(address);
}

export function parseCharacterRelationshipsAddress(input: {
  id: string;
  context?: unknown;
  realm?: unknown;
  stream?: unknown;
  cursor?: unknown;
  work?: unknown;
}): CharacterRelationshipsAddress | undefined {
  if (!characterUuid.test(input.id)) return undefined;
  const context = typeof input.context === 'string' && characterUuid.test(input.context) ? input.context : undefined;
  const realm = typeof input.realm === 'string' && characterUuid.test(input.realm) ? input.realm : undefined;
  const stream =
    typeof input.stream === 'string' &&
    input.stream.length > 0 &&
    input.stream.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(input.stream)
      ? input.stream
      : undefined;
  const cursor =
    typeof input.cursor === 'string' &&
    input.cursor.length > 0 &&
    input.cursor.length <= 8192 &&
    !/[\u0000-\u001f\u007f]/u.test(input.cursor)
      ? input.cursor
      : undefined;
  const work = typeof input.work === 'string' && characterUuid.test(input.work) ? input.work : undefined;
  if (cursor && !stream) return undefined;
  return {
    id: input.id,
    ...(context ? { context } : {}),
    ...(realm ? { realm } : {}),
    ...(stream ? { stream } : {}),
    ...(cursor ? { cursor } : {}),
    ...(work ? { work } : {}),
  };
}

/** Changing character, work, stream or release identity retires the previous rows before a new read. */
export function associationReadingKey(
  address: CharacterRelationshipsAddress,
  generation: number,
  release?: string,
): string {
  return JSON.stringify([
    address.id,
    address.stream ?? '',
    address.cursor ?? '',
    address.work ?? '',
    generation,
    release ?? '',
  ]);
}
