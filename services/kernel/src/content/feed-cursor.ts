import { createHash } from 'node:crypto';
import type { FeedSelection } from './feed-contract.ts';
import type { Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type FeedPosition = {
  boundary: string;
  turn: number;
  discovery: string | null | false;
  following: string | null | false;
  continue: string | null | false;
  resume: { fingerprint: string; after: string } | null;
};
export const FEED_CURSOR_BYTES = 32768;
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function feedBinding(
  actor: Actor,
  stream: string,
  limit: number,
  languages: readonly string[],
  kind?: string,
  selection: FeedSelection = {},
): ListCursorBinding {
  return {
    route: 'GET /v1/feedItems/v1',
    viewer: actor.kind === 'account' ? actor.accountId : null,
    query: {
      stream,
      limit,
      languages: languages.join(','),
      authority: fingerprint(actor),
      ...(kind === undefined ? {} : { kind }),
      ...selection,
    },
  };
}

/** Each bounded part uses the existing encrypted, authenticated native envelope. The digest and
 * part/count bindings prevent splicing. Only owner positions are retained, never hydrated data. */
export async function encodeFeedCursor(
  tokens: KeyRing,
  binding: ListCursorBinding,
  position: FeedPosition,
  now: Date,
): Promise<string> {
  const json = JSON.stringify(position);
  const digest = fingerprint(position);
  const bytes = Buffer.from(json).toString('base64url');
  const parts = bytes.match(/.{1,1800}/g)!;
  if (parts.length > 12) throw new ProblemError('dependency_unavailable');
  const encoded = await Promise.all(
    parts.map((part, index) =>
      encodeListCursor(
        tokens,
        { ...binding, query: { ...binding.query, digest, index, count: parts.length } },
        { epoch: 1, after: [part] },
        now,
        { profile: 'search' },
      ),
    ),
  );
  const result = [digest, ...encoded].join('.');
  if (result.length > FEED_CURSOR_BYTES) throw new ProblemError('dependency_unavailable');
  return result;
}

export async function decodeFeedCursor(
  tokens: KeyRing,
  binding: ListCursorBinding,
  cursor: string,
  now: Date,
): Promise<FeedPosition> {
  if (cursor.length > FEED_CURSOR_BYTES) throw new ProblemError('invalid_cursor');
  const [digest, ...parts] = cursor.split('.');
  if (!digest || !/^[0-9a-f]{64}$/.test(digest) || parts.length < 1 || parts.length > 12)
    throw new ProblemError('invalid_cursor');
  const chunks = await Promise.all(
    parts.map(async (part, index) => {
      const decoded = await decodeListCursor(
        tokens,
        { ...binding, query: { ...binding.query, digest, index, count: parts.length } },
        part,
        now,
        { profile: 'search' },
      );
      if (!decoded.ok) throw new ProblemError(decoded.reason === 'expired' ? 'stale_cursor' : 'invalid_cursor');
      if (decoded.epoch !== 1 || decoded.after.length !== 1 || typeof decoded.after[0] !== 'string')
        throw new ProblemError('invalid_cursor');
      return decoded.after[0];
    }),
  );
  try {
    const value: FeedPosition = JSON.parse(Buffer.from(chunks.join(''), 'base64url').toString('utf8'));
    if (
      fingerprint(value) !== digest ||
      !Number.isFinite(Date.parse(value.boundary)) ||
      !Number.isInteger(value.turn) ||
      value.turn < 0 ||
      value.turn > 2 ||
      !['discovery', 'following', 'continue'].every((key) => {
        const entry = value[key as 'discovery'];
        return entry === null || entry === false || typeof entry === 'string';
      }) ||
      (value.resume !== null &&
        (typeof value.resume?.fingerprint !== 'string' || typeof value.resume.after !== 'string'))
    )
      throw new Error();
    return value;
  } catch {
    throw new ProblemError('invalid_cursor');
  }
}
