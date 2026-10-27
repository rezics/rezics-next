import type { Pool, PoolClient } from 'pg';
import { runCommand } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { requestDigest } from '../http/request.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import read from './preferences-read.sql';
import set from './preferences-set.sql';

export const SHELF_LAYOUTS = ['grid', 'list', 'table'] as const;
export const SHELF_TABS = ['in_progress', 'planned', 'completed', 'paused', 'dropped', 'all'] as const;
export const SHELF_SORT_FIELDS = [
  'last_activity',
  'added',
  'finished',
  'title',
  'rating',
  'release_date',
  'progress',
] as const;
export const SHELF_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const SHELF_GRID_SIZES = ['small', 'medium', 'large'] as const;
export const SHELF_TABLE_COLUMNS = [
  'cover',
  'title',
  'creator',
  'type',
  'status',
  'progress',
  'rating',
  'added',
  'started',
  'finished',
  'last_activity',
] as const;
export const SHELF_MAX_LAYOUTS = 32;
export const SHELF_SCOPE_MAX_LENGTH = 256;
/** `all` or an absolute IRI: a scheme, a colon and no whitespace. */
export const SHELF_SCOPE_PATTERN = '^(?:all|[A-Za-z][A-Za-z0-9+.-]*:\\S+)$';
const scopePattern = new RegExp(SHELF_SCOPE_PATTERN);

export type ShelfLayout = (typeof SHELF_LAYOUTS)[number];
export type ShelfTab = (typeof SHELF_TABS)[number];
export type ShelfSort = {
  field: (typeof SHELF_SORT_FIELDS)[number];
  direction: (typeof SHELF_SORT_DIRECTIONS)[number];
};
export type Shelf = {
  layouts?: Record<string, ShelfLayout>;
  sorts?: Partial<Record<ShelfTab, ShelfSort>>;
  gridSize?: (typeof SHELF_GRID_SIZES)[number];
  tableColumns?: (typeof SHELF_TABLE_COLUMNS)[number][];
};
/** A JSON Merge Patch (RFC 7396) over {@link Shelf}: `null` removes, an array replaces. */
export type ShelfPatch = {
  layouts?: Record<string, ShelfLayout | null> | null;
  sorts?: Partial<
    Record<ShelfTab, { field?: ShelfSort['field'] | null; direction?: ShelfSort['direction'] | null } | null>
  > | null;
  gridSize?: Shelf['gridSize'] | null;
  tableColumns?: Shelf['tableColumns'] | null;
};
export type AccountPreferences = {
  spoilerLevel: 0 | 1 | 2;
  suitability: 'blur' | 'show';
  shelf: Shelf;
  version: number;
};
export const DEFAULT_ACCOUNT_PREFERENCES: Readonly<AccountPreferences> = Object.freeze({
  spoilerLevel: 0,
  suitability: 'blur',
  shelf: Object.freeze({}),
  version: 0,
});
export type PreferenceChange = {
  expectedVersion: number;
  spoilerLevel?: 0 | 1 | 2;
  suitability?: 'blur' | 'show';
  shelf?: ShelfPatch | null;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const member = (values: readonly unknown[], value: unknown) => values.includes(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const validScope = (key: string) => key.length <= SHELF_SCOPE_MAX_LENGTH && scopePattern.test(key);

/** Shape of a patch: every known part may be `null`; unknown keys are refused at every level. */
export function validShelfPatch(patch: unknown): boolean {
  if (!isObject(patch) || !onlyKeys(patch, ['layouts', 'sorts', 'gridSize', 'tableColumns'])) return false;
  const { layouts, sorts, gridSize, tableColumns } = patch;
  if (layouts !== undefined && layouts !== null) {
    if (!isObject(layouts)) return false;
    for (const [key, value] of Object.entries(layouts))
      if (!validScope(key) || (value !== null && !member(SHELF_LAYOUTS, value))) return false;
  }
  if (sorts !== undefined && sorts !== null) {
    if (!isObject(sorts) || !onlyKeys(sorts, SHELF_TABS)) return false;
    for (const entry of Object.values(sorts)) {
      if (entry === null) continue;
      if (!isObject(entry) || !onlyKeys(entry, ['field', 'direction'])) return false;
      if (entry.field != null && !member(SHELF_SORT_FIELDS, entry.field)) return false;
      if (entry.direction != null && !member(SHELF_SORT_DIRECTIONS, entry.direction)) return false;
    }
  }
  if (gridSize != null && !member(SHELF_GRID_SIZES, gridSize)) return false;
  return tableColumns == null || Array.isArray(tableColumns);
}

/** Rules for a stored shelf: complete sort entries, bounded maps, distinct ordered columns. */
function validShelf(shelf: unknown): shelf is Shelf {
  if (!isObject(shelf) || !onlyKeys(shelf, ['layouts', 'sorts', 'gridSize', 'tableColumns'])) return false;
  const { layouts, sorts, gridSize, tableColumns } = shelf;
  if (layouts !== undefined) {
    if (!isObject(layouts) || Object.keys(layouts).length > SHELF_MAX_LAYOUTS) return false;
    for (const [key, value] of Object.entries(layouts))
      if (!validScope(key) || !member(SHELF_LAYOUTS, value)) return false;
  }
  if (sorts !== undefined) {
    if (!isObject(sorts) || !onlyKeys(sorts, SHELF_TABS)) return false;
    for (const entry of Object.values(sorts))
      if (
        !isObject(entry) ||
        !onlyKeys(entry, ['field', 'direction']) ||
        !member(SHELF_SORT_FIELDS, entry.field) ||
        !member(SHELF_SORT_DIRECTIONS, entry.direction)
      )
        return false;
  }
  if (gridSize !== undefined && !member(SHELF_GRID_SIZES, gridSize)) return false;
  if (tableColumns !== undefined)
    if (
      !Array.isArray(tableColumns) ||
      tableColumns.length < 1 ||
      tableColumns.length > SHELF_TABLE_COLUMNS.length ||
      new Set(tableColumns).size !== tableColumns.length ||
      !tableColumns.every((column) => member(SHELF_TABLE_COLUMNS, column))
    )
      return false;
  return true;
}

/** RFC 7396 over in-memory values. */
function mergePatch(target: Json | undefined, patch: Json): Json | undefined {
  if (patch === null) return undefined;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base: { [key: string]: Json } =
    target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    const merged = mergePatch(base[key], value);
    if (merged === undefined) delete base[key];
    else base[key] = merged;
  }
  return base;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );

/** The shelf after a patch, or `null` when the patch or the merged result breaks a rule. */
export function mergeShelf(stored: Shelf, patch: ShelfPatch | null): Shelf | null {
  if (patch === null) return {};
  if (!validShelfPatch(patch)) return null;
  const merged = mergePatch(stored as Json, patch as Json) as unknown;
  return validShelf(merged) ? merged : null;
}

/** One account-key seek, at most one row; missing storage means the defaults. */
export async function readAccountPreferences(
  client: Pick<Pool | PoolClient, 'query'>,
  accountId: string,
): Promise<AccountPreferences> {
  const route = routeOf(accountId);
  if (route === null) throw new ProblemError('invalid_request');
  const row = await read.run(client, { route, account_id: accountId });
  return row
    ? {
        ...row,
        spoilerLevel: row.spoilerLevel as 0 | 1 | 2,
        suitability: row.suitability as 'blur' | 'show',
        shelf: row.shelf as Shelf,
      }
    : { ...DEFAULT_ACCOUNT_PREFERENCES, shelf: {} };
}

/** Serializable read/compare/write touches one preference row and the command receipt.
 * The acting account alone owns this state, including in an operator-opened session.
 */
export function createPreferenceCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async setPreferences(
      context: AccessContext & { actor: Actor },
      input: PreferenceChange & { accountId: string; key: string },
    ) {
      input = structuredClone(input);
      const { actor } = context;
      if (actor.kind !== 'account' || actor.accountId !== input.accountId || context.pool !== config.pool)
        throw new ProblemError('forbidden');
      const route = routeOf(input.accountId);
      if (
        route === null ||
        !Number.isInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        input.expectedVersion > 2147483646 ||
        (input.spoilerLevel !== undefined && ![0, 1, 2].includes(input.spoilerLevel)) ||
        (input.suitability !== undefined && !['blur', 'show'].includes(input.suitability)) ||
        (input.shelf != null && !validShelfPatch(input.shelf)) ||
        Object.keys(input).some(
          (key) => !['accountId', 'key', 'expectedVersion', 'spoilerLevel', 'suitability', 'shelf'].includes(key),
        )
      )
        throw new ProblemError('invalid_request');
      const partition = partitionOf(route);
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: 'account:update',
        anchor: { resource: { route, id: input.accountId }, validate: async () => true },
        context: { pool: context.pool, deadline: context.deadline, partition },
      });
      return runCommand(
        config.pool,
        {
          partition,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          deadline: context.deadline,
          clock: config.clock,
          authorization,
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'access.account.preferences',
            key: input.key,
            digest: requestDigest('account.set_preferences', actor, input),
          },
        },
        async (tx) => {
          const current = await readAccountPreferences(tx, input.accountId);
          if (current.version !== input.expectedVersion) throw new ProblemError('conflict');
          const shelf = input.shelf === undefined ? current.shelf : mergeShelf(current.shelf, input.shelf);
          if (shelf === null) throw new ProblemError('invalid_request');
          const next = {
            ...current,
            spoilerLevel: input.spoilerLevel ?? current.spoilerLevel,
            suitability: input.suitability ?? current.suitability,
            shelf,
          };
          if (
            next.spoilerLevel !== current.spoilerLevel ||
            next.suitability !== current.suitability ||
            canonical(next.shelf) !== canonical(current.shelf)
          ) {
            const changed = await set.run(tx, {
              route,
              account_id: input.accountId,
              spoiler_level: next.spoilerLevel,
              suitability: next.suitability,
              shelf: next.shelf,
              expected_version: input.expectedVersion,
            });
            if (!changed) throw new ProblemError('conflict');
            next.version = changed.version;
          }
          return {
            value: next,
            events: [
              {
                type: 'com.rezics.access.account-updated.v1',
                subject: input.accountId,
                data: { accountId: input.accountId },
              },
            ],
          };
        },
      );
    },
  };
}
