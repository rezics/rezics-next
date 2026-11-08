import { expect, test } from 'bun:test';
import { createCommunityApplication } from '../../src/community/application/index.ts';

test('Community application executes one selected preparation port and returns its source components', async () => {
  const calls: unknown[] = [];
  const expected = {
    preparation: { subject: { originalId: 'original', currentId: 'terminal' } },
    components: [{ partition: 1, epoch: 2, position: 3n }],
  };
  const application = createCommunityApplication({
    access: {
      createMembership: () => null,
      createParticipation: () => null,
    },
    effects: { effects: () => [] },
    publicationPreparation: {
      read: async (input) => {
        calls.push(input);
        return expected;
      },
    },
    ambient: { deadlineNow: () => 1 },
  });
  const input = {
    dependencies: {},
    realmId: 'realm',
    subjectId: 'original',
    context: { actor: { kind: 'account' }, deadline: 2, languages: ['en'] },
  };

  await expect(application.readPublicationPreparation(input)).resolves.toBe(expected);
  expect(calls).toEqual([input]);
});
