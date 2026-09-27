import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AgentProfileInvalid, checkedAgentProfile } from '../src/modules/agent/profile.ts';

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
