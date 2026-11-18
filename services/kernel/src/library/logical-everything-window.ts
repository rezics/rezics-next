import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor, Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  observePrivateSubjectDisclosure,
  privateSubjectDisclosureFootprint,
  type PrivateSubjectDisclosure,
} from '../semantic/private-subject-disclosure.ts';
import type { NativeCollectionWork } from './collection-native-work.ts';
import { instrumentNativeCollectionWork } from './collection-native-work.ts';
import { withCollectionReadConnection } from './collection-read-connection.ts';
import { LIBRARY_SUBJECT_PAGE_LIMIT } from './contract/presentation.ts';
import type { PreparedCollectionSource } from './collection-source.ts';
import { builtinCollectionId } from './builtin-identity.ts';
import windowQuery from './logical-everything-window.sql';

type Dependencies = { pool: Pool; access: Access; actor: AccountActor; deadline: number; work: NativeCollectionWork };
type Pair = { original: string; terminal: string };
type Row = Pair & { driver: number; fact_id: string; present: boolean; generation: string };
const unavailable = () => new ProblemError('semantic_not_ready');

export function everythingWindowFootprint(sql: string, values: readonly unknown[]) {
  if (sql !== windowQuery.sql || values.length !== 12) return undefined;
  const [route, owner, id, version, incarnation, fence, identity, basis, capture, revision, after, take] = values;
  if (
    typeof owner !== 'string' ||
    routeOf(owner) !== route ||
    typeof id !== 'string' ||
    routeOf(id) !== route ||
    typeof version !== 'string' ||
    !/^\d{1,19}$/.test(version) ||
    incarnation !== id + ':everything' ||
    typeof fence !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fence) ||
    typeof identity !== 'string' ||
    Buffer.byteLength(identity) > 4096 ||
    typeof basis !== 'string' ||
    !/^[a-f0-9]{64}$/.test(basis) ||
    typeof capture !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(capture) ||
    typeof revision !== 'string' ||
    !/^\d{1,19}$/.test(revision) ||
    (after !== null && (typeof after !== 'string' || routeOf(after) === null)) ||
    typeof take !== 'number' ||
    !Number.isSafeInteger(take) ||
    take < 2 ||
    take > 2 * LIBRARY_SUBJECT_PAGE_LIMIT + 1
  )
    return undefined;
  // Read the publication and capture heads, one ordered reference range, then at most three
  // fact points per raw row. Include the physical key used to prove or disprove exhaustion.
  return {
    statements: 1,
    nativeRows: 48 + 12 * take,
    nativePoints: 14 + 3 * take,
    candidateKeys: take,
    witnessKeys: take,
    identityMetadataRows: 0,
    emptySeeks: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + 256 * take,
  };
}

/** The final raw key is order evidence. Only EOF or the next terminal closes a group. */
export async function readPublishedEverythingWindow(
  deps: Dependencies,
  source: PreparedCollectionSource,
  after: string | null,
  limit: number,
) {
  const { observation, queryCapture } = source;
  const identity = observation.sourceIdentity;
  if (
    !queryCapture ||
    observation.revision !== 0 ||
    identity.scope !== 'private_builtin' ||
    identity.accountId !== deps.actor.accountId ||
    identity.collectionId !== builtinCollectionId(deps.actor.accountId, { kind: 'everything' }) ||
    identity.incarnation !== identity.collectionId + ':everything' ||
    !identity.effectKey.startsWith('collection-source:') ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 2 * LIBRARY_SUBJECT_PAGE_LIMIT
  )
    throw unavailable();
  const take = limit + 1;
  const values = [
    identity.route,
    identity.accountId,
    identity.collectionId,
    identity.generation,
    identity.incarnation,
    identity.effectKey.slice('collection-source:'.length),
    JSON.stringify(identity),
    observation.basis.digest,
    queryCapture.id,
    queryCapture.revision,
    after,
    take,
  ];
  const result = await instrumentNativeCollectionWork(deps.pool, deps.work, everythingWindowFootprint, () =>
    withCollectionReadConnection(deps.pool, deps.deadline, (client) => client.query<Row>(windowQuery.sql, values)),
  );
  const first = result.rows[0];
  if (!first || result.rows.length > take) throw unavailable();
  if (first.original === null) {
    if (result.rows.length !== 1 || first.terminal !== null || first.present !== null) throw unavailable();
    return { generation: first.generation, rows: [], exhausted: true, incompleteTerminal: null };
  }
  let previous: Row | undefined;
  let previousKey: string | undefined;
  let aliases = 0;
  for (const row of result.rows) {
    if (row.terminal !== previous?.terminal) aliases = 0;
    if (row.terminal !== previous?.terminal || row.original !== previous?.original) aliases++;
    // UUID text and the four single-digit driver ordinals preserve the index tuple order.
    const key = [row.terminal, row.original, row.driver, row.fact_id].join('/');
    if (
      routeOf(row.original) === null ||
      routeOf(row.terminal) === null ||
      routeOf(row.fact_id) === null ||
      !Number.isInteger(row.driver) ||
      row.driver < 1 ||
      row.driver > 4 ||
      typeof row.present !== 'boolean' ||
      row.generation !== first.generation ||
      (after !== null && row.terminal <= after) ||
      aliases > LIBRARY_SUBJECT_PAGE_LIMIT ||
      (previousKey !== undefined && key <= previousKey)
    )
      throw unavailable();
    previous = row;
    previousKey = key;
  }
  const exhausted = result.rows.length < take;
  return {
    generation: first.generation,
    rows: result.rows,
    exhausted,
    incompleteTerminal: exhausted ? null : result.rows.at(-1)!.terminal,
  };
}

/** Every pair, including a withheld, repeated or order-only input, survives until the last disclosure. */
export async function observeEverythingPairs(deps: Dependencies, pairs: readonly Pair[], at: AuthoritativeTime) {
  const directed = new Map<string, string>();
  for (const pair of pairs) {
    if (directed.has(pair.original) && directed.get(pair.original) !== pair.terminal) throw unavailable();
    directed.set(pair.original, pair.terminal);
  }
  const observations: Extract<PrivateSubjectDisclosure, { status: 'complete' }>[] = [];
  for (let offset = 0; offset < Math.max(1, pairs.length); offset += LIBRARY_SUBJECT_PAGE_LIMIT) {
    const batch = pairs.slice(offset, offset + LIBRARY_SUBJECT_PAGE_LIMIT);
    const observation = await instrumentNativeCollectionWork(
      deps.pool,
      deps.work,
      privateSubjectDisclosureFootprint,
      () => observePrivateSubjectDisclosure({ ...deps, ownerId: deps.actor.accountId }, batch, at),
    );
    if (
      observation.status !== 'complete' ||
      observation.decisions.length !== batch.length ||
      !observation.decisions.every(
        (decision, i) => decision.original === batch[i]!.original && decision.terminal === batch[i]!.terminal,
      )
    )
      throw unavailable();
    observations.push(observation);
  }
  return {
    decisions: observations.flatMap((observation) => observation.decisions),
    async revalidate(fresh: AuthoritativeTime) {
      for (const observation of observations) {
        if (
          !(await instrumentNativeCollectionWork(deps.pool, deps.work, privateSubjectDisclosureFootprint, () =>
            observation.revalidate(fresh),
          ))
        )
          throw unavailable();
      }
    },
  };
}
