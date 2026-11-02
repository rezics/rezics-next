export type ShelfLabelInputError = 'invalid' | 'transport_limit';

export type ShelfLabelPrefix =
  | { ok: true; query: string }
  | { ok: false; error: ShelfLabelInputError };

/** Mirrors the server action's raw UTF-16 transport bound; native meaning is the normalized scalar limit below. */
export function normalizeShelfLabelPrefix(raw: string): ShelfLabelPrefix {
  if (raw.length > 4096) return { ok: false, error: 'transport_limit' };
  const query = raw.normalize('NFC').replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/g, '');
  if (/[\p{Cc}\p{Cs}]/u.test(query)) return { ok: false, error: 'invalid' };
  let scalars = 0;
  for (const _scalar of query) if (++scalars > 100) return { ok: false, error: 'invalid' };
  return { ok: true, query };
}
