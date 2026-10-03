import { expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address/sid';
import { normalizeVanity, suggestVanity } from '../src/modules/agent/vanity.ts';
import { ensurePersonOnboarding } from '../src/modules/onboarding/ensure.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { suggestedHandle } from '../../../apps/web/features/onboarding/handle.ts';

test('G-973: typed names yield valid readable handles without identity tokens', () => {
  const uuid = '4adce769-09a8-48cc-9bbf-3b33938d0405';
  for (const [name, expected] of [
    ['reader', 'reader'],
    ['Reader-Name', 'reader-name'],
    ['Lin Mei 林梅', 'lin_mei'],
    ['Éloïse', 'eloise'],
    ['林梅', 'reader'],
    ['ليلى', 'reader'],
    ['ab', 'reader'],
    [uuid, 'reader'],
    [uuidToSid(uuid), 'reader'],
    [`林梅 ${uuid}`, 'reader'],
    [`Lin Mei ${uuid}`, 'lin_mei'],
    ['a'.repeat(200), 'a'.repeat(30)],
  ]) {
    expect(suggestVanity(name!), name).toBe(expected!);
    expect(normalizeVanity(suggestVanity(name!)), name).toBe(expected!);
    expect(suggestedHandle(name!), name).toBe(
      ['林梅', 'ليلى', 'ab', uuid, uuidToSid(uuid), `林梅 ${uuid}`].includes(name!)
        ? ''
        : expected!,
    );
  }
});

test('G-973: onboarding probes handle availability from the saved public name on retries', async () => {
  const agent = 'https://rezics.com/id/4adce769-09a8-48cc-9bbf-3b33938d0405';
  let suggestedName: string | undefined;
  const work = {
    account: { verify: async () => ({ issuer: 'https://account.test', subject: 'principal' }) },
    onboardingPersons: { activeName: async () => 'reader', provisionName: async () => 'reader' },
    agentProvisioning: { provision: async () => ({ agent, state: 'active', replayed: true }) },
    sessionAgents: { readSession: async () => ({ sessionAgent: { actingSubject: agent } }) },
    agentHandles: {
      suggest: async (name: string) => {
        suggestedName = name;
        return 'reader2';
      },
    },
  } as unknown as MainWorkDependencies;
  const result = await ensurePersonOnboarding(
    work,
    new Request('https://main.test'),
    'session',
    'Different name',
  );
  expect(suggestedName).toBe('reader');
  expect(result).toMatchObject({ suggestedHandle: 'reader2', sessionAgent: agent, replayed: true });
});
