import type { RealmMembershipCommandAttempt } from '../realm-membership-lifetime';
import type { MyRealmsCurrentRow, MyRealmsEpisode } from './contract';

export type AvailableLeaveAdvice = Extract<MyRealmsCurrentRow['current']['actions']['leave'], { state: 'available' }>;

export type MyRealmsFrozenLeaveIntent = Readonly<{
  page: object;
  visitId: string;
  accountId: string;
  realmId: string;
  name: string;
  row: MyRealmsCurrentRow;
  episode: MyRealmsEpisode;
  advice: AvailableLeaveAdvice;
  credential: string;
  source: string;
  attempt: RealmMembershipCommandAttempt;
}>;

export function episodeFromRow(row: MyRealmsCurrentRow): MyRealmsEpisode {
  const membership = row.current.viewer.membership;
  if (membership.state !== 'member') throw new Error('My Realms leave selection has no current membership');
  return Object.freeze({
    since: membership.since,
    reservationId: membership.reservationId,
    transactionId: membership.transactionId,
  });
}

export function sameEpisode(left: MyRealmsEpisode, right: MyRealmsEpisode): boolean {
  return (
    left.since === right.since &&
    left.reservationId === right.reservationId &&
    left.transactionId === right.transactionId
  );
}

/** A later page may keep the Realm while replacing the selected episode or its exact command advice. */
export function sameLeaveAdmission(intent: MyRealmsFrozenLeaveIntent, row: MyRealmsCurrentRow): boolean {
  if (row.realmId !== intent.realmId || row.current.viewer.membership.state !== 'member') return false;
  return (
    sameEpisode(episodeFromRow(row), intent.episode) &&
    JSON.stringify(row.current.actions.leave) === JSON.stringify(intent.advice)
  );
}

export function sourceForLeaveIntent(
  accountId: string,
  realmId: string,
  episode: MyRealmsEpisode,
  advice: AvailableLeaveAdvice,
): string {
  return JSON.stringify([
    'my-realms-leave-v1',
    accountId,
    realmId,
    episode.since,
    episode.reservationId,
    episode.transactionId,
    advice.method,
    advice.path,
    advice.expectedStatus,
  ]);
}

export function createMyRealmsLeaveIntent(input: {
  page: object;
  visitId: string;
  accountId: string;
  row: MyRealmsCurrentRow;
  advice: AvailableLeaveAdvice;
  credential: string;
  key: string;
  observation: number;
}): MyRealmsFrozenLeaveIntent {
  const episode = episodeFromRow(input.row);
  const source = sourceForLeaveIntent(input.accountId, input.row.realmId, episode, input.advice);
  const attempt = Object.freeze({
    realmId: input.row.realmId,
    actor: input.accountId,
    credential: input.credential,
    body: Object.freeze({ realmId: input.row.realmId, action: 'leave' as const, idempotencyKey: input.key }),
    observation: input.observation,
    source,
  });
  return Object.freeze({
    page: input.page,
    visitId: input.visitId,
    accountId: input.accountId,
    realmId: input.row.realmId,
    name: input.row.name,
    row: input.row,
    episode,
    advice: Object.freeze({ ...input.advice }),
    credential: input.credential,
    source,
    attempt,
  });
}

export function attemptMatchesIntent(
  attempt: RealmMembershipCommandAttempt,
  intent: Pick<MyRealmsFrozenLeaveIntent, 'accountId' | 'realmId' | 'credential' | 'source'>,
): boolean {
  return (
    attempt.actor === intent.accountId &&
    attempt.realmId === intent.realmId &&
    attempt.credential === intent.credential &&
    attempt.body.action === 'leave' &&
    attempt.body.realmId === intent.realmId &&
    attempt.source === intent.source
  );
}
