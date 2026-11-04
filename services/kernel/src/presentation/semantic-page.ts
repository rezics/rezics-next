import {
  definedViews,
  resolveView,
  type PageDocumentRead,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { classifyUnavailability, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { globalReadEligibility, relatedReadEligibility } from '../semantic/eligibility.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readItemDetails } from '../semantic/subject.ts';
import statesRead from '../semantic/subject-summary-states.sql';
import type { SummaryReaderDependencies } from '../semantic/summaries.ts';
import { activeProfile } from './profiles.ts';

/** Native correction operations on an admitted quotation; Type descriptors never grant these. */
export const quotationCorrectionActions = [
  { action: 'statement:propose', operationId: 'subject.propose' },
  { action: 'context:accept', operationId: 'subject.accept_candidate' },
  { action: 'context:adopt', operationId: 'subject.adopt' },
] as const;

export type PageViewer = { kind: 'anonymous' } | { kind: 'account' };
export type PageActionState = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'absent' | 'withheld';
export type PageAction = { action: string; operationId: string; state: PageActionState };

/** Current release admission of schema:Quotation, including descendants. Historical pins omit this type. */
export function quotationTypeAdmitted(
  release: { types?: Record<string, { bases?: readonly string[] }> } | undefined,
  type: string | null | undefined,
): boolean {
  if (!type || !release?.types?.['schema:Quotation']) return false;
  return type === 'schema:Quotation' || (release.types[type]?.bases ?? []).includes('schema:Quotation');
}

const quotationTextProperties = ['schema:text', 'schema:abstract'] as const;

/** Ordinary overview Summary hydrates schema:abstract; admitted quotation text still needs the document composition. */
export function quotationPageDocuments(
  base: PageDocumentRead | null,
  release:
    | {
        types?: Record<string, { bases?: readonly string[] }>;
        properties?: Record<string, { datatype?: string }>;
      }
    | undefined,
  type: string | null | undefined,
  subject: string | null,
  available: readonly string[],
  context?: string,
): PageDocumentRead | null {
  if (subject === null || !quotationTypeAdmitted(release, type)) return base;
  const extra = quotationTextProperties.filter(
    (id) => available.includes(id) && release?.properties?.[id]?.datatype === 'document',
  );
  if (!extra.length) return base;
  const properties = [...new Set([...(base?.properties ?? []), ...extra])].sort();
  return {
    kind: 'documents',
    id: subject,
    ...(context ? { context } : {}),
    properties,
  };
}

/** Derive quotation correction actions with native Access under the actual caller. */
export async function readQuotationPageAuthority(deps: {
  pool: Pool;
  access: Access;
  actor: Actor;
  deadline: number;
}): Promise<{ viewer: PageViewer; actions: PageAction[] }> {
  const viewer: PageViewer = { kind: deps.actor.kind === 'account' ? 'account' : 'anonymous' };
  const context = { pool: deps.pool, deadline: deps.deadline };
  const resource = { route: 0, id: GLOBAL_CONTEXT };
  const prepared = await Promise.all(
    quotationCorrectionActions.map(async (entry) => {
      try {
        return { ...entry, check: await accessCheck(deps.access, deps.actor, entry.action, resource, context) };
      } catch (error) {
        if (classifyUnavailability(error)) return { ...entry, state: 'unavailable' as const, check: null };
        throw error;
      }
    }),
  );
  const actions = await withReadTransaction(
    deps.pool,
    async (client) => {
      const result: PageAction[] = [];
      for (const entry of prepared) {
        if (!entry.check) {
          result.push({ action: entry.action, operationId: entry.operationId, state: 'unavailable' });
          continue;
        }
        try {
          result.push({
            action: entry.action,
            operationId: entry.operationId,
            state: (await entry.check(client)) ? 'allowed' : 'denied',
          });
        } catch (error) {
          if (classifyUnavailability(error))
            result.push({ action: entry.action, operationId: entry.operationId, state: 'unavailable' });
          else throw error;
        }
      }
      return result;
    },
    deps.deadline,
  );
  return { viewer, actions };
}

/** The ordinary native page's template order and offered views, shared with pages.read. */
export function semanticPageView(
  profile: PresentationProfile,
  release: Release | undefined,
  type: string,
  view: View = 'overview',
) {
  const definition = release?.types[type];
  const target = { type, ...(definition === undefined ? {} : { bases: definition.bases }) };
  const resolved = resolveView(profile, target, view);
  return resolved === null ? null : { resolved, views: definedViews(profile, target) };
}

export type CataloguePageDefinitions = Pick<Release, 'types' | 'properties'>;
export type CataloguePageMetadata = {
  state: 'released' | 'unsupported' | 'unavailable';
  type: string;
  digest?: string;
  definitions?: CataloguePageDefinitions;
};

const catalogueFileTypes = ['schema:MediaObject', 'rezics:CatalogueFile', 'wd:Q82753'];
const catalogueGroupTypes = ['rezics:ReleaseGroup', 'wd:Q55327'];

function typeIsA(release: CataloguePageDefinitions, type: string, base: string, seen = new Set<string>()): boolean {
  if (type === base) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((candidate) => typeIsA(release, candidate, base, seen));
}

/** The ordinary page carries only the current file/group descriptor and its directed relation vocabulary. */
export function cataloguePageMetadata(
  release: CataloguePageDefinitions | undefined,
  digest: string | undefined,
  type: string,
): CataloguePageMetadata | undefined {
  const candidate = [...catalogueFileTypes, ...catalogueGroupTypes].includes(type);
  const file = catalogueFileTypes.some((base) => release && typeIsA(release, type, base));
  const group = catalogueGroupTypes.some((base) => release && typeIsA(release, type, base));
  if (!candidate && !file && !group) return;
  if (!release || !digest) return { state: 'unavailable', type };
  if (!release.types[type] || (!file && !group)) return { state: 'unsupported', type, digest };

  const propertyIds = new Set(release.types[type]?.properties ?? []);
  const inversePropertyIds = new Set<string>();
  for (const [id, property] of Object.entries(release.properties)) {
    if (property.relation && (property.targets ?? []).some((target) => typeIsA(release, type, target))) {
      propertyIds.add(id);
      inversePropertyIds.add(id);
    }
  }
  const pendingProperties = [...propertyIds];
  for (let index = 0; index < pendingProperties.length; index++)
    for (const qualifier of release.properties[pendingProperties[index]!]?.qualifiers ?? [])
      if (!propertyIds.has(qualifier)) {
        propertyIds.add(qualifier);
        pendingProperties.push(qualifier);
      }
  const properties = Object.fromEntries(
    [...propertyIds].flatMap((id) => (release.properties[id] ? [[id, release.properties[id]]] : [])),
  );
  const types = new Set<string>([type]);
  const addType = (id: string) => {
    if (types.has(id) || !release.types[id]) return;
    types.add(id);
    for (const base of release.types[id]?.bases ?? []) addType(base);
  };
  for (const property of Object.values(properties)) for (const target of property.targets ?? []) addType(target);
  for (const [owner, definition] of Object.entries(release.types))
    if ((definition.properties ?? []).some((id) => inversePropertyIds.has(id))) addType(owner);
  const typeDefinitions = Object.fromEntries(
    [...types].flatMap((id) => (release.types[id] ? [[id, release.types[id]]] : [])),
  );
  return {
    state: 'released',
    type,
    digest,
    definitions: { types: typeDefinitions, properties },
  };
}

export type PublicSemanticPageMetadata = {
  views: readonly string[];
  /** An Account association vetoes independent Subject fallback; it never proves an Account target. */
  independentSubject: boolean;
};

/** Native metadata only: no renderer, leaf dispatch, profile-declared permission or retained allow. */
export async function preparePublicSemanticPageMetadata(deps: SummaryReaderDependencies, ids: readonly string[]) {
  if (ids.length > 100) throw new RangeError('Page metadata accepts at most 100 ids');
  const groups = new Map<number, string[]>();
  for (const id of new Set(ids)) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Page metadata requires full routed keys');
    const home = partitionOf(route);
    const group = groups.get(home) ?? [];
    group.push(id);
    groups.set(home, group);
  }
  const actor = { kind: 'anonymous' as const };
  const observe = async () => {
    requireAccessDeadline(deps.deadline);
    // Prepare outside every source checkout. Each observation creates fresh native Access evidence.
    const gates = await Promise.all(
      (['presentation:read', 'subject:read'] as const).map((action) =>
        accessCheck(
          deps.access,
          actor,
          action,
          { route: 0, id: GLOBAL_CONTEXT, eligibility: globalReadEligibility(action) },
          { pool: deps.pool, deadline: deps.deadline },
        ),
      ),
    );
    const anchor = async (client: Parameters<typeof readPartition>[0], home: number) => {
      const owner = await readPartition(client, home);
      if (!owner) throw new CommandUnavailableError('contention', home);
      if (owner.writeState !== 'active')
        throw new CommandUnavailableError(owner.writeState === 'moved' ? 'moved' : 'fenced', home, owner.movedTo);
      return owner.epoch;
    };
    const global = await withReadTransaction(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      const epoch = await anchor(client, 0);
      let allowed = true;
      for (const gate of gates) if (!(await gate(client))) allowed = false;
      return { epoch, allowed };
    });
    const profile = await activeProfile(deps.pool);
    const release = await activeRelease(deps.pool);
    type State = Awaited<ReturnType<typeof statesRead.run>>[number];
    type Detail = Awaited<ReturnType<typeof readItemDetails>> extends Map<string, infer T> ? T : never;
    const rows = new Map<string, { state: State; detail: Detail; epoch: number; allowed: boolean }>();
    if (global.allowed && profile && release) {
      for (const [home, group] of groups) {
        const checks = new Map(
          await Promise.all(
            group.map(
              async (id) =>
                [
                  id,
                  await accessCheck(
                    deps.access,
                    actor,
                    'subject:read',
                    {
                      route: routeOf(id)!,
                      id,
                      eligibility: relatedReadEligibility({ route: routeOf(id)!, id }, group),
                    },
                    { pool: deps.pool, deadline: deps.deadline },
                  ),
                ] as const,
            ),
          ),
        );
        await withReadTransaction(deps.pool, async (connection) => {
          // Eligibility memoization is limited to this snapshot, never a pooled connection.
          const client = deadlineClient({ query: connection.query.bind(connection) }, deps.deadline);
          const epoch = await anchor(client, home);
          const states = await statesRead.run(client, {
            partition_no: home,
            routes: group.map((id) => routeOf(id)!),
            subject_ids: group,
          });
          const details = await readItemDetails(client, group);
          for (const state of states) {
            const detail = details.get(state.id);
            if (detail) rows.set(state.id, { state, detail, epoch, allowed: await checks.get(state.id)!(client) });
          }
        });
      }
    }
    requireAccessDeadline(deps.deadline);
    return { global, profile, release, rows };
  };
  const before = await observe();
  return {
    async finish(): Promise<Map<string, PublicSemanticPageMetadata | null>> {
      const current = await observe();
      const result = new Map<string, PublicSemanticPageMetadata | null>(ids.map((id) => [id, null]));
      if (
        !before.global.allowed ||
        !current.global.allowed ||
        before.global.epoch !== current.global.epoch ||
        !before.profile ||
        !current.profile ||
        !before.release ||
        !current.release ||
        before.profile.head !== current.profile.head ||
        before.profile.digest !== current.profile.digest ||
        before.release.head !== current.release.head ||
        before.release.digest !== current.release.digest
      )
        return result;
      for (const id of result.keys()) {
        const old = before.rows.get(id),
          row = current.rows.get(id);
        // Equality only rejects changed data. Fresh native guards above supply permission.
        if (
          !old?.allowed ||
          !row?.allowed ||
          JSON.stringify(old) !== JSON.stringify(row) ||
          row.state.visibility !== 'visible' ||
          row.state.redirect
        )
          continue;
        const page = semanticPageView(current.profile.profile, current.release.release, row.detail.type);
        if (page) result.set(id, { views: page.views, independentSubject: row.detail.agentAccountId === null });
      }
      return result;
    },
  };
}
