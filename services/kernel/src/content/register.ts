import { createAccess } from '../access/index.ts';
import resourceRoles from '../access/resource-roles.json';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import {
  AUTH_CONSENT_VARIABLES,
  createAuthConsentReader,
  readAuthConsentConfig,
  type CurrentConsentReader,
} from '../access/auth-consent.ts';
import type { KernelClock } from '../clock.ts';
import type { Pool } from 'pg';
import type { AccessRealmRoleReader } from '../request/access.ts';
import { createRealmMembership } from '../community/membership.ts';
import { contentEffects, contentNoticeEffects } from './relays.ts';
import type { WorkModule } from '../work/registry.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaImportFetchConfig } from './media-import.ts';
import { R2Storage } from './r2-storage.ts';
import { createContentWork } from './work.ts';
import { readContentWorkConfig, type ContentWorkConfig } from './work-config.ts';
import { registerFeedWork } from './feed-work.ts';
import { createConversationActivityEffect } from './conversation-activity.ts';

/** Standalone fixture/caller Access with the shared role catalogue. Default
 * production registration uses WorkContext's fully mounted authorization instead.
 * Reads outside a command bind this kernel clock. */
export function createContentWorkAccess(clock: KernelClock, pool?: Pool) {
  let access: ReturnType<typeof createAccess> | undefined;
  let membership: ReturnType<typeof createRealmMembership> | undefined;
  const roles = () =>
    access && pool ? (membership ??= createRealmMembership({ pool, access, clock })).roleReader : undefined;
  const realmRoleReader: AccessRealmRoleReader = Object.assign(
    ((client, input) => roles()!(client, input)) as AccessRealmRoleReader,
    { batch: ((client, input) => roles()!.batch!(client, input)) as NonNullable<AccessRealmRoleReader['batch']> },
  );
  // Resolve the original producers only when Access asks for them, after its
  // own factory returned. Forwarding the producer itself preserves callback
  // context/result identity and never constructs another role mirror.
  Object.defineProperties(realmRoleReader, {
    work: { get: () => roles()?.work },
    batchWork: { get: () => roles()?.batchWork },
  });
  const publicReads = new Set(['subject:read', 'board:read', 'thread:read', 'post:read', 'realm:read', 'space:read']);
  access = createAccess({
    actions: new Map(
      Object.values(resourceRoles.roles)
        .flat()
        .map((action) => [action, { anonymous: publicReads.has(action) }]),
    ),
    clock,
    ...(pool ? { realmRoleReader } : {}),
  });
  return access;
}

/** A configured dependency is absent. The call touches no storage, network or operation state. */
export class ContentDependencyUnavailableError extends Error {
  readonly code = 'dependency_unavailable' as const;
  constructor() {
    super('dependency_unavailable');
    this.name = 'ContentDependencyUnavailableError';
  }
}

export type ContentWorkDependencies = Readonly<{
  config: ContentWorkConfig;
  absentGroups: readonly Readonly<{ name: string; variables: readonly string[] }>[];
  storage: MediaStorage;
  readConsent: CurrentConsentReader;
  fetchConfig: MediaImportFetchConfig;
}>;

function testCollectionPartitions(env: Readonly<Record<string, string | undefined>>): readonly number[] | undefined {
  const value = env.CONTENT_TEST_COLLECTION_PARTITIONS;
  if (value === undefined) return undefined;
  const partitions = value.split(',').map((part) => Number(part));
  if (
    partitions.length === 0 ||
    new Set(partitions).size !== partitions.length ||
    partitions.some((partition) => !Number.isInteger(partition) || partition < 0 || partition >= 4096)
  )
    throw new RangeError('Invalid content collection partitions');
  return partitions;
}

/** One port factory for registration and tests. Absent groups fail closed and do not construct a client. */
export function contentWorkDependencies(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: (request: Request) => Promise<Response>,
): ContentWorkDependencies {
  const config = readContentWorkConfig(env);
  const consent = readAuthConsentConfig(env);
  return Object.freeze({
    config,
    absentGroups: Object.freeze([
      ...config.absentGroups,
      ...(consent === null ? [Object.freeze({ name: 'consent', variables: AUTH_CONSENT_VARIABLES })] : []),
    ]),
    storage: config.storage === null ? unavailableStorage() : new R2Storage({ ...config.storage, fetch: fetchImpl }),
    readConsent: consent === null ? unavailableConsent() : createAuthConsentReader(consent),
    fetchConfig: Object.freeze({ allowedHosts: config.sourceHosts }),
  });
}

function unavailableStorage(): MediaStorage {
  return {
    async get(): Promise<Uint8Array | null> {
      throw new ContentDependencyUnavailableError();
    },
    async put(): Promise<void> {
      throw new ContentDependencyUnavailableError();
    },
    async deletePrefix(): Promise<void> {
      throw new ContentDependencyUnavailableError();
    },
  };
}

function unavailableConsent(): CurrentConsentReader {
  return async () => {
    throw new ContentDependencyUnavailableError();
  };
}

/** Sole kernel worker composition entry; configuration comes from its shared context. */
export const registerContent: WorkModule = {
  name: 'content',
  async register(context) {
    const dependencies = contentWorkDependencies(context.env, fetch);
    const collectionPartitions = testCollectionPartitions(context.env);
    for (const group of dependencies.absentGroups) {
      console.info(`content ${group.name} group is absent: ${group.variables.join(', ')}`);
    }
    const { access, readConsent } = context.getAuthorization();
    await createContentWork({
      storage: dependencies.storage,
      access,
      readConsent,
      routeKey: readMembershipRouteKey(context.env),
      fetchConfig: dependencies.fetchConfig,
      ...(collectionPartitions === undefined ? {} : { collectionPartitions }),
    }).register(context);
    context.addEffects([
      createConversationActivityEffect(context.pool),
      ...contentEffects(context.pool, context.client),
      ...contentNoticeEffects(context.pool, access),
    ]);
    await registerFeedWork(context);
  },
};
