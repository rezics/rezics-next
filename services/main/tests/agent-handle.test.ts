import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { normalizeVanity, RESERVED_HANDLES, suggestVanity, VanityInvalid }
  from '../src/modules/agent/vanity.ts';
import { agentForHandle, allocateAgentHandle } from '../src/modules/agent/handle.ts';

test('G284: vanity syntax, case folding, reserved routes and native namespace stay separate', () => {
  expect(normalizeVanity('Lin_Mei')).toBe('lin_mei');
  for (const value of ['ab', 'a'.repeat(31), 'bad-name', 'élo', 'foo.bar', 'admin', 'REZICS', 'works']) {
    expect(() => normalizeVanity(value)).toThrow(VanityInvalid);
  }
  for (const entry of readdirSync(new URL('../../../apps/web/app/', import.meta.url),
    { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('(')) {
      expect(() => normalizeVanity(entry.name)).toThrow(VanityInvalid);
    }
  }
  for (const word of ['admin', 'administrator', 'moderator', 'staff', 'support', 'rezics']) {
    expect(RESERVED_HANDLES.has(word)).toBe(true);
  }
  const agent = `https://rezics.com/id/${randomUUID()}`;
  expect(agentForHandle(allocateAgentHandle(agent))).toBe(agent);
  expect(() => normalizeVanity(allocateAgentHandle(agent))).toThrow(VanityInvalid);
  expect(suggestVanity('Lin Mei 林梅')).toBe('lin_mei');
  expect(suggestVanity('林梅')).toBe('reader');
});
