import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

export const WEB_PUBLICATION_PROFILE = 'https://rezics.com/definition/web-publication-v1';
export const WEB_SNAPSHOT_PROFILE_ID = 'web-snapshot-v1';
export const WEB_SNAPSHOT_PROFILE = 'https://rezics.com/definition/web-snapshot-v1';
/** A content page is larger than an Open Library JSON record and still capped.
 * The timeout matches that source capture. */
export const WEB_SNAPSHOT_COST = {
  maxBytes: 262_144,
  timeoutMs: 5_000,
  snapshots: 20,
  // The two live edit checks can each read author and public catalogue proofs.
  commandGraphCalls: 16,
  commandGraphBytes: 1024 * 1024,
  deadlineMs: 10_000,
} as const;

const closed = { additionalProperties: false } as const;
const native = t.String({
  pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const text = (maxLength: number) =>
  t.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const coverage = t.Object({ scope: text(120), complete: t.Boolean() }, closed);
const when = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' });

export const snapshotWrite = t.Union([
  t.Object(
    {
      profile: t.Literal('web-snapshot-v1'),
      actingSubject: native,
      id: native,
      acquisition: t.Literal('fixture'),
      bytesBase64: t.String({ minLength: 4, maxLength: 360_000 }),
      mediaType: t.String({ pattern: '^[a-z]+/[a-z0-9.+-]+$', maxLength: 80 }),
      fetchedAt: when,
      coverage,
    },
    closed,
  ),
  t.Object(
    {
      profile: t.Literal('web-snapshot-v1'),
      actingSubject: native,
      id: native,
      acquisition: t.Literal('fetch'),
      coverage,
    },
    closed,
  ),
]);

export type SnapshotWrite = Static<typeof snapshotWrite>;
export interface SnapshotRecord {
  id: string;
  publication: string;
  work: string;
  acquisition: 'fixture' | 'fetch';
  fetchedAt: string;
  byteDigest: string;
  byteLength: number;
  mediaType: string;
  coverage: { scope: string; complete: boolean };
  actingSubject: string;
}
export class InvalidWebSnapshot extends Error {}
export class SnapshotNotFound extends Error {}
export class SnapshotRobotsDenied extends Error {}
export class SnapshotRightsDenied extends Error {}
export class WebSnapshotUnavailable extends Error {}

export function decodeFixtureBytes(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new InvalidWebSnapshot('Snapshot bytes are not base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > WEB_SNAPSHOT_COST.maxBytes) {
    throw new InvalidWebSnapshot('Snapshot bytes are outside the capture limit');
  }
  return bytes;
}

export function checkedSnapshotIdentity(input: unknown): SnapshotWrite {
  if (!Value.Check(snapshotWrite, input))
    throw new InvalidWebSnapshot('Snapshot does not match its schema');
  if (input.acquisition === 'fixture') {
    const fetched = Date.parse(input.fetchedAt);
    if (Number.isNaN(fetched)) throw new InvalidWebSnapshot('Snapshot fetch time is invalid');
    decodeFixtureBytes(input.bytesBase64);
  }
  return input;
}

export function snapshotDigest(record: SnapshotRecord): string {
  return createHash('sha256')
    .update(JSON.stringify({ profile: WEB_SNAPSHOT_PROFILE, ...record }))
    .digest('hex');
}
