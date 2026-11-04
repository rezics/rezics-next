import {
  definedViews,
  resolveView,
  type PageDocumentRead,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { deadlineClient } from '../access/authenticate.ts';
import { classifyUnavailability, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { globalReadEligibility, relatedReadEligibility } from '../semantic/eligibility.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readItemDetails } from '../semantic/subject.ts';
import statesRead from '../semantic/subject-summary-states.sql';
import type { SummaryReaderDependencies } from '../semantic/summaries.ts';
import { activeProfile } from './profiles.ts';
import {
  createReleasedRelationDirectionResolver,
  type ReleasedRelationDirectionResult,
} from '../semantic/released-relation-direction.ts';

/** Native correction operation on an admitted quotation; Type descriptors never grant this. */
export const quotationCorrectionActions = [{ action: 'statement:propose', operationId: 'subject.propose' }] as const;

export type PageViewer = { kind: 'anonymous' } | { kind: 'account' };
export type PageActionState = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'absent' | 'withheld';
export type PageAction = { action: string; operationId: string; state: PageActionState };

/** Current release admission of schema:Quotation, including descendants. Historical pins omit this type. */
export function quotationTypeAdmitted(
  release: { types?: Record<string, { bases?: readonly string[] }> } | undefined,
  type: string | null | undefined,
): boolean {
  if (!type || !release?.types?.['schema:Quotation']) return false;
  const seen = new Set<string>();
  const extendsQuotation = (candidate: string): boolean => {
    if (candidate === 'schema:Quotation') return true;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return (release.types?.[candidate]?.bases ?? []).some(extendsQuotation);
  };
  return extendsQuotation(type);
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
  const [propose] = quotationCorrectionActions;
  const unavailable = [{ action: propose.action, operationId: propose.operationId, state: 'unavailable' as const }];
  try {
    const check = await accessCheck(
      deps.access,
      deps.actor,
      propose.action,
      { route: 0, id: GLOBAL_CONTEXT },
      { pool: deps.pool, deadline: deps.deadline },
    );
    const allowed = await withConnection(deps.pool, (client) => check(client));
    return {
      viewer,
      actions: [{ action: propose.action, operationId: propose.operationId, state: allowed ? 'allowed' : 'denied' }],
    };
  } catch (error) {
    if (classifyUnavailability(error)) return { viewer, actions: unavailable };
    throw error;
  }
}

export type PageViewerActions =
  | { status: 'ready'; viewerActions: { action: string; operations: string[] }[] }
  | { status: 'withheld' }
  | { status: 'unavailable' }
  | { status: 'denied' };

/** Map the existing viewer-actions owner result onto the composed page envelope. */
export function pageViewerActions(
  type: string,
  id: string,
  result: { status: number; body: unknown },
): { viewer: { type: string; id: string }; actions: PageViewerActions } {
  const viewer = { type, id };
  if (result.status === 401 || result.status === 403) return { viewer, actions: { status: 'denied' } };
  if (result.status !== 200 || typeof result.body !== 'object' || result.body === null || Array.isArray(result.body))
    return { viewer, actions: { status: 'unavailable' } };
  const resources = (result.body as { resources?: unknown }).resources;
  const row = Array.isArray(resources)
    ? resources.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { type?: unknown }).type === type &&
          (entry as { id?: unknown }).id === id,
      )
    : undefined;
  if (!row || typeof row !== 'object') return { viewer, actions: { status: 'unavailable' } };
  if ((row as { error?: unknown }).error === 'not_found') return { viewer, actions: { status: 'withheld' } };
  const viewerActions = (row as { viewerActions?: unknown }).viewerActions;
  if (!Array.isArray(viewerActions)) return { viewer, actions: { status: 'unavailable' } };
  return {
    viewer,
    actions: {
      status: 'ready',
      viewerActions: viewerActions.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const action = (entry as { action?: unknown }).action;
        const operations = (entry as { operations?: unknown }).operations;
        if (
          typeof action !== 'string' ||
          !Array.isArray(operations) ||
          operations.length === 0 ||
          operations.some((item) => typeof item !== 'string')
        )
          return [];
        return [{ action, operations: [...new Set(operations as string[])] }];
      }),
    },
  };
}

export const characterWorkType = 'wd:Q95074';
export const appearanceProperty = 'schema:character';
export const identityProperty = 'rezics:relatedCharacterIdentity';
export const appearanceAgeProperty = 'wdt:P3629';
export const spoilerProperty = 'rezics:spoilerLevel';
export type CharacterWorkUnavailableId = 'age-at-appearance' | 'main-character-linkage' | 'character-relationship';
export type CharacterWorkIdentityOverlay = {
  unavailable: { id: CharacterWorkUnavailableId; admitted: false }[];
  meanings: Record<string, { text: string; lang: string | null }>;
};

function isType(release: Pick<Release, 'types'>, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

function targetsCharacter(property: PropertyDefinition | undefined, release: Pick<Release, 'types'>): boolean {
  return !!property?.targets?.some(
    (target) => isType(release, characterWorkType, target) || isType(release, target, characterWorkType),
  );
}

function pickLabel(labels: Record<string, string> | undefined, locale: string): { text: string; lang: string | null } {
  const text = labels?.[locale] ?? labels?.en ?? '';
  return { text, lang: labels?.[locale] ? locale : labels?.en ? 'en' : null };
}

/** Released Character identity, appearance-age and relationship admission for the current release. */
export function characterWorkIdentityOverlay(
  release: Pick<Release, 'types' | 'properties'>,
  type: string,
  locale: string,
): CharacterWorkIdentityOverlay | undefined {
  if (type !== characterWorkType) return;
  const appearance = release.properties[appearanceProperty];
  const unavailable: CharacterWorkIdentityOverlay['unavailable'] = [];
  const ageAdmitted =
    !!appearance?.qualifiers.includes(appearanceAgeProperty) ||
    !!appearance?.qualifiers.some((id) => release.properties[id]?.datatype === 'quantity' && id !== spoilerProperty);
  if (!ageAdmitted) unavailable.push({ id: 'age-at-appearance', admitted: false });
  const identity = release.properties[identityProperty];
  const identityAdmitted =
    identity?.datatype === 'wikibase-item' &&
    identity.relation?.group === 'association' &&
    targetsCharacter(identity, release);
  if (!identityAdmitted) unavailable.push({ id: 'main-character-linkage', admitted: false });
  const relationships = Object.entries(release.properties).some(([id, property]) => {
    if (id === identityProperty) return false;
    const group = property.relation?.group;
    return (
      property.datatype === 'wikibase-item' &&
      (group === 'association' || group === 'world') &&
      targetsCharacter(property, release)
    );
  });
  if (!relationships) unavailable.push({ id: 'character-relationship', admitted: false });
  const meanings: CharacterWorkIdentityOverlay['meanings'] = {};
  for (const id of [
    appearanceProperty,
    appearanceAgeProperty,
    identityProperty,
    'wdt:P26',
    'wdt:P3373',
    'wdt:P22',
    'wdt:P25',
    'wdt:P451',
    'rezics:characterRival',
    spoilerProperty,
    'wdt:P3831',
    'wdt:P1932',
    'wdt:P518',
  ]) {
    const property = release.properties[id];
    if (property) meanings[id] = pickLabel(property.labels, locale);
  }
  return { unavailable, meanings };
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
  directions?: ReleasedRelationDirectionResult[];
};

const catalogueFileTypes = ['schema:MediaObject', 'rezics:CatalogueFile', 'wd:Q82753'];
const catalogueGroupTypes = ['rezics:ReleaseGroup', 'wd:Q55327'];
const catalogueMusicTypes = ['schema:MusicAlbum', 'schema:MusicRelease', 'schema:MusicRecording'];
const catalogueCharacterTypes = ['wd:Q95074'];
const cataloguePeopleTypes = ['schema:Person', 'schema:Organization'];
const catalogueReleaseTypes = ['bf:Instance', 'rezics:AnimeRelease', 'wd:Q20631656'];
const catalogueLiteraryTypes = ['schema:Book', 'schema:BookSeries', 'bf:Instance'];

function typeIsA(release: CataloguePageDefinitions, type: string, base: string, seen = new Set<string>()): boolean {
  if (type === base) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((candidate) => typeIsA(release, candidate, base, seen));
}

/** Person and Organization, including descendants, admit biography and producer history on the ordinary page. */
export function peopleProducerTypeAdmitted(release: CataloguePageDefinitions | undefined, type: string) {
  return cataloguePeopleTypes.some((base) => release !== undefined && typeIsA(release, type, base));
}

/** The ordinary page carries its current catalogue descriptor and released relation directions. */
export function cataloguePageMetadata(
  release: Release | undefined,
  digest: string | undefined,
  type: string,
): CataloguePageMetadata | undefined {
  const candidate = [
    ...catalogueFileTypes,
    ...catalogueGroupTypes,
    ...catalogueMusicTypes,
    ...catalogueCharacterTypes,
    ...cataloguePeopleTypes,
    ...catalogueReleaseTypes,
    ...catalogueLiteraryTypes,
  ].includes(type);
  const file = catalogueFileTypes.some((base) => release && typeIsA(release, type, base));
  const group = catalogueGroupTypes.some((base) => release && typeIsA(release, type, base));
  const music = catalogueMusicTypes.some((base) => release && typeIsA(release, type, base));
  const character = catalogueCharacterTypes.some((base) => release && typeIsA(release, type, base));
  const people = peopleProducerTypeAdmitted(release, type);
  const catalogueRelease = catalogueReleaseTypes.some((base) => release && typeIsA(release, type, base));
  const literary = catalogueLiteraryTypes.some((base) => release && typeIsA(release, type, base));
  if (!candidate && !file && !group && !music && !people && !catalogueRelease && !literary) return;
  if (!release || !digest) return { state: 'unavailable', type, directions: [] };
  if (!release.types[type] || (!file && !group && !music && !character && !people && !catalogueRelease && !literary))
    return { state: 'unsupported', type, digest, directions: [] };

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
  const resolveDirection = createReleasedRelationDirectionResolver(release, digest);
  const directionProperties = new Set([...release.types[type]!.properties, ...inversePropertyIds]);
  const directions = [...directionProperties]
    .filter((id) => release.properties[id]?.relation)
    .sort()
    .flatMap((id) => [
      ...(inversePropertyIds.has(id) ? [resolveDirection.resolve(type, id, 'inverse')] : []),
      ...(release.types[type]!.properties.includes(id) ? [resolveDirection.resolve(type, id, 'forward')] : []),
    ]);
  const types = new Set<string>([type]);
  const addType = (id: string) => {
    if (types.has(id) || !release.types[id]) return;
    types.add(id);
    for (const base of release.types[id]?.bases ?? []) addType(base);
  };
  for (const base of release.types[type]?.bases ?? []) addType(base);
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
    directions,
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

const peopleProducerCorrectionActions = [
  { action: 'statement:propose', operationId: 'subject.propose' },
  { action: 'context:accept', operationId: 'subject.accept_candidate' },
  { action: 'context:adopt', operationId: 'subject.adopt' },
] as const;

export type PeopleProducerActionState = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'absent' | 'withheld';

export async function readPeopleProducerPageAuthority(
  deps: { access: Access; pool: Pool },
  actor: Actor,
  deadline: number,
): Promise<{
  viewer: { kind: 'anonymous' | 'account' };
  actions: { action: string; operationId: string; state: PeopleProducerActionState }[];
}> {
  const viewer = { kind: actor.kind === 'account' ? ('account' as const) : ('anonymous' as const) };
  const unavailable = peopleProducerCorrectionActions.map((entry) => ({
    action: entry.action,
    operationId: entry.operationId,
    state: 'unavailable' as const,
  }));
  try {
    requireAccessDeadline(deadline);
    const prepared = await Promise.all(
      peopleProducerCorrectionActions.map(async (entry) => ({
        ...entry,
        check: await accessCheck(
          deps.access,
          actor,
          entry.action,
          { route: 0, id: GLOBAL_CONTEXT },
          { pool: deps.pool, deadline },
        ),
      })),
    );
    requireAccessDeadline(deadline);
    const actions = await withReadTransaction(
      deps.pool,
      async (client) => {
        const states: { action: string; operationId: string; state: PeopleProducerActionState }[] = [];
        for (const entry of prepared) {
          let state: PeopleProducerActionState = 'denied';
          try {
            state = (await entry.check(client)) ? 'allowed' : 'denied';
          } catch (error) {
            if (classifyUnavailability(error)) state = 'unavailable';
            else throw error;
          }
          states.push({ action: entry.action, operationId: entry.operationId, state });
        }
        return states;
      },
      deadline,
    );
    return { viewer, actions };
  } catch (error) {
    if (classifyUnavailability(error)) return { viewer, actions: unavailable };
    throw error;
  }
}
