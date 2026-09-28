import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AgentProfileInvalid, checkedAgentProfile } from '../src/modules/agent/profile.ts';
import { agentLocalizedName } from '../src/modules/agent/localized-name.ts';

const input = () => ({ agent: `https://rezics.com/id/${randomUUID()}`,
  expectedHead: `https://rezics.com/id/${randomUUID()}`, displayName: ' 林 梅 ',
  avatarSelection: null, bio: { text: '  写作者  ', language: 'zh-Hans' }, idempotencyKey: 'edit-1' });

test('G-300: Agent profile normalizes Unicode and rejects controls, excess text and invalid references', () => {
  expect(checkedAgentProfile(input())).toMatchObject({ displayName: '林 梅',
    bio: { text: '写作者', language: 'zh-Hans' } });
  for (const changed of [
    { displayName: '   ' }, { displayName: 'A\u0085B' }, { displayName: '界'.repeat(201) },
    { bio: { text: 'bad\nline', language: 'en' } },
    { bio: { text: 'ok', language: 'invalid_tag' } },
    { avatarSelection: 'a different Agent' }, { idempotencyKey: '' },
  ]) expect(() => checkedAgentProfile({ ...input(), ...changed })).toThrow(AgentProfileInvalid);
});

test('G-437: Agent v2 language literals retain one original while v1 JSON remains readable', () => {
  const rows = [
    { localizedName: { value: 'North Star Editions', 'xml:lang': 'en' },
      originalNameLanguage: { value: 'en' } },
    { localizedName: { value: '北辰出版', 'xml:lang': 'zh-hans' },
      originalNameLanguage: { value: 'en' } },
  ];
  expect(agentLocalizedName(rows, 'North Star Editions')).toEqual({ original: 'en',
    labels: { en: 'North Star Editions', 'zh-Hans': '北辰出版' } });
  expect(agentLocalizedName([{ localizedName: { value: JSON.stringify({ original: 'en',
    labels: { en: 'North Star Editions', 'zh-Hans': '北辰出版' } }) } }],
  'North Star Editions')).toEqual({ original: 'en',
    labels: { en: 'North Star Editions', 'zh-Hans': '北辰出版' } });
  expect(agentLocalizedName([{}], 'A name')).toBeNull();
  expect(() => agentLocalizedName(rows, 'Different')).toThrow();
  expect(() => agentLocalizedName([...rows, rows[0]!], 'North Star Editions')).toThrow();
  expect(() => agentLocalizedName([{ localizedName: { value: 'Name', 'xml:lang': 'en' },
    originalNameLanguage: { value: 'ja' } }], 'Name')).toThrow();
});
