import { routeOf } from '../route/route.ts';
import { createHash } from 'node:crypto';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { ContentReadDependencies } from './reads.ts';
import {
  nativeModerationAuthorityUnavailable,
  type ModerationDirectoryAuthorityReader,
} from './moderation-directory-authority.ts';
import {
  observeModerationDirectoryCoverage,
  readModerationDirectoryReferences,
} from './moderation-directory-projection.ts';
import { observeNativeModerationScope, type ModerationScopeObservation } from './moderation-directory-source.ts';
import type { ModerationDirectoryInput, ModerationDirectoryPage } from './moderation-directory-schemas.ts';

/** Named absent candidate dependency retained for callers without native composition. */
export async function nativeModerationCandidateReferencesUnavailable(): Promise<ModerationDirectoryPage> {
  return { state: 'unavailable', items: [], next: null };
}
export type ModerationDirectoryDependencies = ContentReadDependencies &
  Readonly<{
    readModerationAuthority?: ModerationDirectoryAuthorityReader;
  }>;
const closed = (state: 'unavailable' | 'preparing' | 'stale'): ModerationDirectoryPage => ({
  state,
  items: [],
  next: null,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

/** Bounded native directory assembly. References establish coverage only; every
 * selected scope obtains native permission and source/parent disclosure twice.
 * An absent authority-currentness port keeps the mounted product unavailable.
 */
export async function readNativeModerationDirectory(
  actor: Actor,
  input: ModerationDirectoryInput,
  dependencies?: ModerationDirectoryDependencies,
  context: Readonly<{ deadline: number; credential?: string }> = {
    deadline: Date.now() + 3000,
  },
): Promise<ModerationDirectoryPage> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
    throw new RangeError('Moderation directory limit must be 1 to 20');
  if (!dependencies) return nativeModerationCandidateReferencesUnavailable();
  const deps = dependencies;
  const now = deps.clock?.() ?? new Date();
  const initial = await observeModerationDirectoryCoverage(deps.pool, context.deadline);
  if (!initial) return closed('unavailable');
  if (!initial.complete) return closed('preparing');
  const readAuthority = deps.readModerationAuthority ?? nativeModerationAuthorityUnavailable;
  // The empty scope set requests the actor/coverage frontier. This MUST cover
  // every possible candidate and negative membership proof, not just output.
  const authorityInput = {
    actor,
    scopes: [],
    coverage: initial.generation,
    deadline: context.deadline,
  };
  const authority = await readAuthority(authorityInput);
  if (
    !authority ||
    !authority.epoch ||
    authority.epoch.length > 128 ||
    !Number.isFinite(authority.validUntil) ||
    authority.validUntil <= now.getTime()
  )
    return closed('unavailable');
  let validUntil = Math.min(now.getTime() + 180_000, authority.validUntil);
  const binding = {
    route: 'GET /v1/me/moderation-directory',
    viewer: actor.accountId,
    query: {
      limit: input.limit,
      realmId: input.realmId ?? null,
      coverage: initial.generation,
      authority: authority.epoch,
      identity: digest([
        actor.clientId,
        actor.authnEpoch,
        actor.requestedBy,
        [...actor.scopes].sort(),
        context.credential ?? null,
      ]),
    },
  };
  let after: readonly [number, string] | undefined;
  let includeCatalogue = input.realmId === undefined;
  if (input.cursor !== undefined) {
    const cursor = await decodeListCursor(deps.tokens, binding, input.cursor, now);
    if (!cursor.ok || cursor.epoch !== 1 || cursor.after.length !== 3) return closed('stale');
    const [route, id, until] = cursor.after;
    if (
      typeof route !== 'number' ||
      !Number.isInteger(route) ||
      route < -1 ||
      route > 65535 ||
      typeof id !== 'string' ||
      (route === -1 ? id !== '00000000-0000-0000-0000-000000000000' : routeOf(id) !== route) ||
      typeof until !== 'number' ||
      until <= now.getTime()
    )
      return closed('stale');
    after = [route, id];
    validUntil = Math.min(validUntil, until);
    includeCatalogue = false;
  }
  const page = await readModerationDirectoryReferences(deps.pool, {
    ...input,
    ...(after === undefined ? {} : { after }),
    // Reserve an output slot for catalogue on the initial unfiltered page.
    limit: input.limit === 1 && includeCatalogue ? 1 : input.limit - (includeCatalogue ? 1 : 0),
    deadline: context.deadline,
  });
  if (!page.coverage?.complete || page.coverage.generation !== initial.generation) return closed('stale');
  const candidates = [
    ...(includeCatalogue ? [{ kind: 'catalogue' as const }] : []),
    ...page.references.map((reference) => ({
      kind: 'board' as const,
      id: reference.boardId,
    })),
  ];
  const observed: ModerationScopeObservation[] = [];
  let last: readonly [number, string] | undefined = after;
  for (const scope of candidates) {
    // A one-item initial page can consume catalogue without losing the first
    // raw Board. The next page resumes BEFORE that unexamined reference.
    if (observed.length === input.limit) break;
    if (scope.kind === 'board') {
      const reference = page.references.find((row) => row.boardId === scope.id)!;
      last = [reference.route, reference.boardId];
    }
    const item = await observeNativeModerationScope(deps, actor, scope, context.deadline);
    if (item) observed.push(item);
  }
  const selectedAuthority = await readAuthority({
    ...authorityInput,
    scopes: observed.map((row) => row.item.scope),
  });
  if (
    !selectedAuthority ||
    selectedAuthority.epoch !== authority.epoch ||
    !Number.isFinite(selectedAuthority.validUntil)
  )
    return closed('stale');
  validUntil = Math.min(validUntil, selectedAuthority.validUntil);
  const items: Extract<ModerationDirectoryPage, { state: 'ready' }>['items'] = [];
  for (const row of observed) {
    const final = await observeNativeModerationScope(deps, actor, row.item.scope, context.deadline);
    if (final?.witness === row.witness) items.push(final.item);
  }
  const finalAuthority = await readAuthority({
    ...authorityInput,
    scopes: items.map((row) => row.scope),
  });
  const coverage = await observeModerationDirectoryCoverage(deps.pool, context.deadline);
  const finalNow = (deps.clock?.() ?? new Date()).getTime();
  if (
    !coverage?.complete ||
    coverage.generation !== initial.generation ||
    !finalAuthority ||
    finalAuthority.epoch !== authority.epoch ||
    !Number.isFinite(finalAuthority.validUntil)
  )
    return closed('stale');
  validUntil = Math.min(validUntil, finalAuthority.validUntil);
  if (validUntil <= finalNow) return closed('stale');
  const unexamined = page.references.some(
    (row) => !last || row.route > last[0] || (row.route === last[0] && row.boardId > last[1]),
  );
  const more =
    unexamined ||
    page.references.length === (input.limit === 1 && includeCatalogue ? 1 : input.limit - (includeCatalogue ? 1 : 0));
  return {
    state: 'ready',
    items,
    next: more
      ? await encodeListCursor(
          deps.tokens,
          binding,
          {
            epoch: 1,
            after: [last?.[0] ?? -1, last?.[1] ?? '00000000-0000-0000-0000-000000000000', validUntil],
          },
          now,
        )
      : null,
    source: digest([initial.generation, authority.epoch, items, validUntil]),
    validUntil: new Date(validUntil).toISOString(),
  };
}
