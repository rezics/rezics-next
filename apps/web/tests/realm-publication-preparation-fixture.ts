import type { PublicationPrepare } from '../src/community/realm-publication-preparation';

/** Supplied-port native reference shape, not a recorded or generated response. */
export function preparationFixture(
  accountId: string,
  head: (subjectId: string) => string | null,
  verdict: 'adopt' | 'withdraw' | 'reject' = 'adopt',
): PublicationPrepare {
  return async ({ realmId, subjectId }) => {
    const current = head(subjectId);
    const command = (action: 'publish' | 'withdraw' | 'reject') => ({
      method: 'POST' as const,
      href: `/v1/realms/${realmId}/publications${action === 'publish' ? '' : `/${subjectId}:${action}`}`,
      subjectId,
      expectedHead: current,
      ifMatch: current === null ? null : JSON.stringify(current),
    });
    return {
      kind: 'ready',
      preparation: {
        realm: { realmId, spaceId: realmId, contextId: realmId, title: 'Selected Realm', hostTitle: 'Selected host' },
        subject: { originalId: subjectId, currentId: subjectId, presentation: { state: 'unavailable' } },
        current: current === null ? null : { publicationId: current, verdict, decidedAt: '2026-11-04T00:00:00Z' },
        commands: {
          publish: command('publish'),
          withdraw: current === null ? null : command('withdraw'),
          reject: current === null ? null : command('reject'),
        },
        viewer: { accountId, clientId: 'fixture', authnEpoch: 1 },
        recovery: { requestIdentity: 'unknown', replay: 'original-command' },
      },
    };
  };
}
