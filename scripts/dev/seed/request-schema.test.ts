import { expect, test } from 'bun:test';
import { assertSeedRequest } from './request-schema.ts';

const uuid = '00000000-0000-4000-a000-000000000001';
const path = `/v1/feed/${uuid}/vote`;
const body = { profile: 'feed-vote-command-v1', actingSubject: `https://rezics.com/id/${uuid}`, expectedRevision: null };

test('G-909: generated numeric vote enums retain the served numeric values', () => {
  for (const value of [-1, 0, 1]) expect(() => assertSeedRequest('POST', path, { ...body, value })).not.toThrow();
  for (const value of ['-1', '0', '1', 2, 0.5]) expect(() => assertSeedRequest('POST', path, { ...body, value })).toThrow();
});
