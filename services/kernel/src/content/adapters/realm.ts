import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { AccessUnavailableError } from '../../access/unavailable.ts';
import type { NativeScopeReader } from '../../semantic/adapters/index.ts';
import type { ScopeWork } from '../../search/adapters/index.ts';
import { createContentRealmApplication } from '../application/index.ts';
import type { RealmCommunityPorts, RealmSearchPorts, RealmSubjectIdentityMapping } from '../contract/index.ts';
import type { BoardRecord, ReadContext, AnchoredPosition } from '../model.ts';
import { observeBoardRecentThreads, type ContentBoardDependencies } from '../boards.ts';
import type { ThreadView } from '../reads.ts';
import { createConversationActivityBatch } from '../conversation-activity.ts';
import {
  projectCommunityCommentsBatch,
  projectCommunityActivitySelection,
  type ConversationActivitySelection,
  type CommunityComments,
} from '../community-projection/index.ts';
import { createRealmSubjectSource, type RealmSubjectSource } from '../realm-subject-source.ts';
import { createRealmSubjectLifecycle } from '../realm-subject-lifecycle.ts';
import {
  createNativeRealmDisclosurePorts,
  realmSearchFailure,
  type NativeRealmDisclosurePorts,
  type RealmSubjectDisclosureContext,
  type RealmSubjectDisclosureDependencies,
} from './realm-disclosure.ts';

type SearchPorts = RealmSearchPorts<
  Pool,
  NativeScopeReader,
  ScopeWork,
  RealmSubjectDisclosureDependencies,
  RealmSubjectDisclosureContext,
  RealmSubjectSource
>;
export type NativeRealmProducers = Pick<NativeRealmDisclosurePorts, 'parent' | 'subject'> & {
  readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<readonly RealmSubjectIdentityMapping[]>;
  withWork<T>(
    reader: Extract<NativeScopeReader, { actor: unknown }>,
    work: ScopeWork,
    maximum: Parameters<SearchPorts['withWork']>[2],
    run: (context: RealmSubjectDisclosureContext) => Promise<T>,
  ): Promise<T>;
};

function nativeCommunity(): RealmCommunityPorts<
  ContentBoardDependencies,
  ReadContext,
  BoardRecord,
  ThreadView,
  CommunityComments,
  ConversationActivitySelection<AnchoredPosition>
> {
  return {
    recent: observeBoardRecentThreads,
    activity(dependencies) {
      const activity = createConversationActivityBatch(dependencies.pool);
      return {
        select: (ids, context) => activity.select(ids, context.deadline),
        confirm: (selected, context) => activity.confirm(selected, context.deadline),
      };
    },
    comments: (ids, selected, context) =>
      projectCommunityCommentsBatch(ids, projectCommunityActivitySelection(selected).items, context.actor),
    same: isDeepStrictEqual,
    unavailable() {
      throw new AccessUnavailableError('contention');
    },
  };
}

/** Composition supplies foreign producers; this adapter selects only Content-native plans. */
export function createNativeContentRealmApplication(producers: NativeRealmProducers, now: () => number) {
  const search: SearchPorts = {
    reader: (pool, reader) => (reader.actor === undefined ? undefined : { pool, access: reader.access }),
    withWork: (reader, work, maximum, run) =>
      producers.withWork(reader as Extract<NativeScopeReader, { actor: unknown }>, work, maximum, run),
    dependency: (realm, signature, ordinal) =>
      createHash('sha256').update(`${realm}:${signature}:${ordinal}`).digest('base64url'),
    failure: realmSearchFailure,
    source(pool, disclosure) {
      const lifecycle = createRealmSubjectLifecycle({ pool, readIdentityMappings: producers.readIdentityMappings });
      return createRealmSubjectSource({ pool, disclosure, maintenance: lifecycle.maintenance });
    },
  };
  return createContentRealmApplication({
    disclosure: createNativeRealmDisclosurePorts(producers, now),
    search,
    community: nativeCommunity(),
  });
}
export type NativeContentRealmApplication = ReturnType<typeof createNativeContentRealmApplication>;
