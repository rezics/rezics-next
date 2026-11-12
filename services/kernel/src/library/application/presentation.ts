import type {
  LibraryPresentationCapability,
  LibraryEmbedding,
  LibraryAccountSummary,
  LibraryTargetSummary,
  FollowingSpaceProjection,
  NativeFollowTargetAdapter,
  NativeFollowProjection,
  LibraryActor,
} from '../contract/index.ts';
import { mapPresentationBounded } from './presentation-bounds.ts';

/** BASIC preserves object identity; FULL reads one ordered related-key set and embeds without hydration. */
export function createLibraryPresentationApplication<Summary, Attribution>(
  capabilities: LibraryPresentationCapability<Summary, Attribution>,
) {
  return async function fullView<T>(
    view: string | undefined,
    body: T,
    options: Readonly<{
      withholdChangedSource?: boolean;
      nativeFollowTargets?: Readonly<{
        adapters: readonly NativeFollowTargetAdapter[];
        actor: LibraryActor;
        deadline: number;
      }>;
      followingSpaces?: (ids: readonly string[]) => Promise<ReadonlyMap<string, FollowingSpaceProjection>>;
    }> = {},
  ): Promise<LibraryEmbedding<T, Summary, Attribution>> {
    if (view !== 'FULL') return body as LibraryEmbedding<T, Summary, Attribution>;
    const rows = Object.values(body as Record<string, unknown>).flatMap((value) =>
      Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [],
    ) as Record<string, unknown>[];
    const subjectIds = new Set<string>(),
      accountIds = new Set<string>();
    const targets = new Map<string, string>();
    const spaceTargetIds = new Set<string>();
    const nativeTargets = new Map<string, NativeFollowTargetAdapter>();
    for (const row of rows) {
      if (typeof row.subjectId === 'string') subjectIds.add(row.subjectId);
      if (typeof row.versionSubjectId === 'string') subjectIds.add(row.versionSubjectId);
      for (const key of ['curatorAccountId', 'accountId']) if (typeof row[key] === 'string') accountIds.add(row[key]);
      if (typeof row.targetId === 'string' && typeof row.targetType === 'string') {
        const native = options.nativeFollowTargets?.adapters.find((adapter) => adapter.targetType === row.targetType);
        if (native) nativeTargets.set(row.targetId, native);
        else if (row.targetType === 'subject') subjectIds.add(row.targetId);
        else if (row.targetType === 'space' && options.followingSpaces) spaceTargetIds.add(row.targetId);
        else targets.set(row.targetId, row.targetType);
      }
    }
    const subjects = await capabilities.subjects([...subjectIds]);
    const attributions = await capabilities.attributions([...accountIds]);
    const accounts = await mapPresentationBounded([...accountIds], async (id) => ({
      id,
      observation: await capabilities.account(id),
    }));
    const targetObservations = await mapPresentationBounded([...targets], async ([id, type]) => ({
      id,
      observation: await capabilities.target(id, type),
    }));
    const followingSpaces = options.followingSpaces
      ? await options.followingSpaces([...spaceTargetIds])
      : new Map<string, FollowingSpaceProjection>();
    const nativeObservations = await mapPresentationBounded([...nativeTargets], async ([id, adapter]) => ({
      id,
      observation: await adapter.observe(options.nativeFollowTargets!.actor, id, options.nativeFollowTargets!.deadline),
    }));
    // Final disclosure occurs after every released related read. No cached allow is authority.
    const subjectsCurrent = await subjects.current();
    if (!subjectsCurrent && !options.withholdChangedSource) throw capabilities.unavailable();
    const attributionCurrent = await attributions.current();
    if (!attributionCurrent && !options.withholdChangedSource) throw capabilities.unavailable();
    const currentAccounts = new Map<string, LibraryAccountSummary | null>();
    await mapPresentationBounded(accounts, async ({ id, observation }) => {
      const current = await observation.current();
      if (!current && !options.withholdChangedSource) throw capabilities.unavailable();
      currentAccounts.set(id, current ? observation.value : null);
    });
    const currentTargets = new Map<string, LibraryTargetSummary | null>();
    await mapPresentationBounded(targetObservations, async ({ id, observation }) => {
      const current = await observation.current();
      if (!current && !options.withholdChangedSource) throw capabilities.unavailable();
      currentTargets.set(id, current ? observation.value : null);
    });
    const currentNative = new Map<string, NativeFollowProjection | null>();
    await mapPresentationBounded(nativeObservations, async ({ id, observation }) => {
      currentNative.set(id, (await observation.current()) ? observation.value : null);
    });
    const enrich = (row: Record<string, unknown>) => {
      const spaceProjection =
        typeof row.targetId === 'string' && row.targetType === 'space' && options.followingSpaces
          ? followingSpaces.get(row.targetId)
          : undefined;
      const native = typeof row.targetId === 'string' && nativeTargets.has(row.targetId);
      const nativeProjection = native ? currentNative.get(row.targetId as string) : undefined;
      return {
        ...row,
        ...(typeof row.subjectId === 'string'
          ? { subject: subjectsCurrent ? (subjects.value.get(row.subjectId) ?? null) : null }
          : {}),
        ...(typeof row.versionSubjectId === 'string'
          ? { versionSubject: subjectsCurrent ? (subjects.value.get(row.versionSubjectId) ?? null) : null }
          : {}),
        ...(typeof row.curatorAccountId === 'string'
          ? { curator: currentAccounts.get(row.curatorAccountId) ?? null }
          : {}),
        ...(typeof row.accountId === 'string'
          ? {
              account: currentAccounts.get(row.accountId) ?? null,
              attribution: attributionCurrent ? (attributions.value.get(row.accountId) ?? null) : null,
            }
          : {}),
        ...(typeof row.targetId === 'string'
          ? {
              target: native
                ? (nativeProjection?.target ?? null)
                : row.targetType === 'subject'
                  ? subjectsCurrent
                    ? (subjects.value.get(row.targetId) ?? null)
                    : null
                  : options.followingSpaces && row.targetType === 'space'
                    ? (spaceProjection?.target ?? null)
                    : (currentTargets.get(row.targetId) ?? null),
            }
          : {}),
        ...(native ? { destination: nativeProjection?.destination ?? { kind: 'unavailable' as const } } : {}),
        ...(options.followingSpaces && typeof row.targetId === 'string' && row.targetType === 'space'
          ? {
              destination: spaceProjection?.destination ?? { kind: 'unavailable' as const },
              actions: spaceProjection?.actions ?? { status: 'unavailable' as const },
            }
          : {}),
      };
    };
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.map((row) => (row && typeof row === 'object' ? enrich(row) : row))
          : value && typeof value === 'object'
            ? enrich(value as Record<string, unknown>)
            : value,
      ]),
    ) as LibraryEmbedding<T, Summary, Attribution>;
  };
}
