import { expect, test } from 'bun:test';
import type { PublicationCommand, RealmPublicationPreparation } from '../src/index.ts';

const preparation: RealmPublicationPreparation = {
  realm: { realmId: 'realm-1', spaceId: 'space-1', contextId: 'context-1', title: 'Realm', hostTitle: 'Space' },
  subject: { originalId: 'subject-1', currentId: 'subject-2', presentation: { state: 'unavailable' } },
  current: { publicationId: 'publication-1', verdict: 'withdraw', decidedAt: '2026-11-04T00:00:00Z' },
  commands: {
    publish: null,
    withdraw: {
      method: 'POST',
      href: '/v1/realms/realm-1/publications/subject-1:withdraw',
      subjectId: 'subject-1',
      expectedHead: 'publication-1',
      ifMatch: JSON.stringify('publication-1'),
    } satisfies PublicationCommand,
    reject: null,
  },
  viewer: { accountId: 'account-1', clientId: 'client-1', authnEpoch: 3 },
  recovery: { requestIdentity: 'unknown', replay: 'original-command' },
};

test('client root exports the Realm publication preparation DTO', () => {
  expect(preparation.commands.withdraw?.expectedHead).toBe(preparation.current?.publicationId);
});
