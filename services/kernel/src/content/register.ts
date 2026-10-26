import { createAccess } from '../access/index.ts';
import resourceRoles from '../access/resource-roles.json';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { createAuthConsentReader, type CurrentConsentReader } from '../access/auth-consent.ts';
import type { KernelClock } from '../clock.ts';
import { contentEffects } from './relays.ts';
import type { WorkModule } from '../work/registry.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaImportFetchConfig } from './media-import.ts';
import { R2Storage } from './r2-storage.ts';
import { createContentWork } from './work.ts';
import { readContentWorkConfig, type ContentWorkConfig } from './work-config.ts';

/** Resolve the shared role catalogue in full; a partial action catalogue would
 * disable owner roles containing actions in addition to post:erase. This private
 * worker Access instance restores native initiators, never HTTP credentials.
 * Reads outside a command bind this kernel clock. */
export function createContentWorkAccess(clock: KernelClock) {
  return createAccess({
    actions: new Map(
      Object.values(resourceRoles.roles)
        .flat()
        .map((action) => [action, { anonymous: false }]),
    ),
    clock,
  });
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
  return Object.freeze({
    config,
    storage: config.storage === null ? unavailableStorage() : new R2Storage({ ...config.storage, fetch: fetchImpl }),
    readConsent:
      config.consent === null
        ? unavailableConsent()
        : createAuthConsentReader({
            url: config.consent.url,
            serviceTokenId: config.consent.serviceTokenId,
            serviceTokenSecret: config.consent.serviceTokenSecret,
          }),
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
    for (const group of dependencies.config.absentGroups) {
      console.info(`content ${group.name} group is absent: ${group.variables.join(', ')}`);
    }
    await createContentWork({
      storage: dependencies.storage,
      access: createContentWorkAccess(context.clock),
      readConsent: dependencies.readConsent,
      routeKey: readMembershipRouteKey(context.env),
      fetchConfig: dependencies.fetchConfig,
      ...(collectionPartitions === undefined ? {} : { collectionPartitions }),
    }).register(context);
    context.addEffects(contentEffects(context.pool, context.client));
  },
};
