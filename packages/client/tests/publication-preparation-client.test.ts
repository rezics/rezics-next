import { expect, test } from 'bun:test';
import type { KernelClient, PublicationCommand, RealmPublicationPreparation } from '../src/index.ts';

type RealmPath = ReturnType<KernelClient['realms']>;
type PublicationPath = ReturnType<RealmPath['publications']>;
type PreparationRead = Awaited<ReturnType<PublicationPath['preparation']['get']>>;

const preparation: RealmPublicationPreparation = {
  realm: {
    realmId: 'realm-1',
    spaceId: 'space-1',
    contextId: 'context-1',
    title: { state: 'available', value: 'Realm' },
    hostTitle: { state: 'available', value: 'Space' },
  },
  subject: {
    originalId: 'subject-1',
    currentId: 'subject-2',
    presentation: {
      original: { label: { state: 'unavailable' }, cover: { state: 'unavailable' } },
      terminal: { label: { state: 'unavailable' }, cover: { state: 'unavailable' } },
    },
  },
  current: { publicationId: 'publication-1', verdict: 'withdraw', decidedAt: '2026-11-04T00:00:00Z' },
  commands: {
    publish: {
      method: 'POST',
      href: '/v1/realms/realm-1/publications',
      subjectId: 'subject-1',
      expectedHead: 'publication-1',
      ifMatch: JSON.stringify('publication-1'),
    },
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

const clientResponse: NonNullable<PreparationRead['data']> = { preparation };

test('client root exports the Realm publication preparation DTO and typed preparation read', () => {
  expect(clientResponse.preparation.commands.withdraw?.expectedHead).toBe(
    clientResponse.preparation.current?.publicationId,
  );
});
