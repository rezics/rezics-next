import { parseFilter, type FilterDocument } from '@rezics/filter';
import type { PageRead } from '@rezics/composition';
import {
  createZoneMembership,
  zoneDigest,
  type ZoneMembership,
  type ZonePending,
  type ZoneSourceDependencies,
  type ZoneSources,
  type ZoneWork,
} from '../zones/membership.ts';
import type { Actor } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { createBuiltinRuntime } from '../library/builtin-runtime.ts';
import type { Pool } from 'pg';

/** TypeList and Members descriptors inherit the Zone's admitted source union and native order. */
export async function zoneTypeListMembership(
  dependencies: ZoneSourceDependencies & { pool: Pool },
  input: {
    actor: Actor;
    at: AuthoritativeTime;
    deadline: number;
    sources: ZoneSources;
    work: ZoneWork;
    descriptor: Extract<PageRead, { kind: 'search' } | { kind: 'members' }>;
  },
): Promise<ZoneMembership | { status: 404; body: { code: 'not_found' } }> {
  const { descriptor, work } = input;
  const base = {
    actor: input.actor,
    at: input.at,
    deadline: input.deadline,
    sources: input.sources,
    work,
  };
  if (descriptor.kind === 'search') {
    return createZoneMembership(dependencies, {
      ...base,
      order: descriptor.body.sort,
      filter: parseFilter(descriptor.body.filter),
      pageSize: descriptor.body.limit,
    });
  }
  const source =
    descriptor.source.kind === 'collection'
      ? { id: descriptor.source.id }
      : await createBuiltinRuntime({ pool: dependencies.pool }).resolve(input.actor, descriptor.source, input.deadline);
  if (!source) return { status: 404, body: { code: 'not_found' } };
  const union = await createZoneMembership(dependencies, base);
  const sourceMembership = await createZoneMembership(dependencies, {
    ...base,
    sources: { ...input.sources, scopes: [], mounts: [source.id] },
    ...(descriptor.filter ? { filter: parseFilter(JSON.parse(descriptor.filter) as FilterDocument) } : {}),
  });
  const streams = sourceMembership.streams.map((stream) => ({
    ...stream,
    async member(id: string, pending?: ZonePending) {
      const own = await stream.member(id, pending?.conjunct === 'zone' ? undefined : pending);
      if (own.value !== true)
        return {
          ...own,
          ...(own.pending ? { pending: { ...own.pending, source: 0, conjunct: 'source' as const } } : {}),
        };
      const match = await union.contains(
        id,
        pending?.conjunct === 'zone' ? { ...pending, source: pending.zoneSource ?? -1 } : undefined,
      );
      return {
        ...match,
        ...(match.pending
          ? {
              pending: { ...match.pending, source: 0, zoneSource: match.pending.source, conjunct: 'zone' as const },
            }
          : {}),
      };
    },
  }));
  return {
    ...sourceMembership,
    streams,
    basis: zoneDigest([sourceMembership.basis, union.basis]),
    async contains(id, pending) {
      if (!streams[0]) return { value: false };
      const match = await streams[0].member(id, pending);
      return { ...match, source: 0 };
    },
  };
}
