import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { normalizeVanity, RESERVED_HANDLES, suggestVanity, VanityInvalid }
  from '../src/modules/agent/vanity.ts';
import { agentForHandle, allocateAgentHandle } from '../src/modules/agent/handle.ts';
import { AgentProvisionInvalid, agentProvisionDigest } from '../src/modules/agent/provision.ts';
import { AgentProfileInvalid, checkedAgentProfile } from '../src/modules/agent/profile.ts';

test('G284: vanity syntax, case folding, reserved routes and native namespace stay separate', () => {
  expect(normalizeVanity('Lin_Mei')).toBe('lin_mei');
  expect(normalizeVanity('Valid-Name')).toBe('valid-name');
  for (const value of ['ab', 'a'.repeat(31), 'élo', 'foo.bar', 'admin', 'REZICS']) {
    expect(() => normalizeVanity(value)).toThrow(VanityInvalid);
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

test('G525: every bidi embedding, override and isolate is rejected in original and translated Agent names', () => {
  const agent = `https://rezics.com/id/${randomUUID()}`;
  const input = { agent, expectedHead: agent, displayName: '林梅', avatarSelection: null,
    bio: null, idempotencyKey: 'name-test' };
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const displayName = `Lin${String.fromCodePoint(code)}Mei`;
    for (const kind of ['person', 'organization', 'service'] as const) {
      expect(() => agentProvisionDigest({ kind, displayName })).toThrow(AgentProvisionInvalid);
    }
    expect(() => checkedAgentProfile({ ...input, displayName })).toThrow(AgentProfileInvalid);
    expect(() => checkedAgentProfile({ ...input, localizedName: { original: 'zh-Hans',
      labels: { 'zh-Hans': '林梅', en: displayName } } })).toThrow(AgentProfileInvalid);
  }
  for (const displayName of ['林梅', 'ليلى', 'לילה', 'Lin Mei']) {
    expect(() => agentProvisionDigest({ kind: 'person', displayName })).not.toThrow();
    expect(checkedAgentProfile({ ...input, displayName }).displayName).toBe(displayName);
  }
});
