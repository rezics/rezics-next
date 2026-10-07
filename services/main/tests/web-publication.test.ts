import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fetchWebSnapshot, robotsAllows } from '../src/modules/web-publication/fetch.ts';
import {
  decodeFixtureBytes,
  SnapshotRightsDenied,
  SnapshotRobotsDenied,
} from '../src/modules/web-publication/schema.ts';
import type { SnapshotTransport } from '../src/modules/web-publication/transport.ts';

test('robots.txt allows the longest matching rule and prefers this capture agent', () => {
  const body =
    'User-agent: *\nDisallow: /\nAllow: /public\n\nUser-agent: REZICS-source-capture\nDisallow: /private\n';
  expect(robotsAllows(body, '/public/story')).toBe(true);
  expect(robotsAllows(body, '/private/chapter')).toBe(false);
  expect(robotsAllows(body, '/other')).toBe(true);
  expect(robotsAllows('User-agent: *\nDisallow: /\n', '/chapter')).toBe(false);
});

test('a fixture snapshot keeps exact bytes, and a live fetch stops for robots or rights', async () => {
  const text = '星港夜話 第一回';
  const bytes = decodeFixtureBytes(Buffer.from(text, 'utf8').toString('base64'));
  expect(createHash('sha256').update(bytes).digest('hex')).toHaveLength(64);
  expect(bytes.toString('utf8')).toBe(text);
  const calls: string[] = [];
  const transport: SnapshotTransport = {
    async get(url: URL) {
      calls.push(url.pathname);
      const body = url.pathname === '/robots.txt' ? 'User-agent: *\nDisallow: /story\n' : 'page';
      return { bytes: Buffer.from(body), status: 200, mediaType: 'text/plain' };
    },
  };
  await expect(
    fetchWebSnapshot('https://example.com/story', {
      transport,
      rightsPermitted: async () => true,
      now: () => new Date('2024-03-01T00:00:00.000Z'),
    }),
  ).rejects.toBeInstanceOf(SnapshotRobotsDenied);
  expect(calls).toEqual(['/robots.txt']);
  await expect(
    fetchWebSnapshot('https://example.com/story', {
      transport,
      rightsPermitted: async () => false,
    }),
  ).rejects.toBeInstanceOf(SnapshotRightsDenied);
});
