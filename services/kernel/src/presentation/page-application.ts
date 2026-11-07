import canonicalize from 'canonicalize';
import {
  documentRead,
  MAX_PAGE_COST,
  PageContinuationError,
  PageReadLimitError,
  planReads,
  platformRegistry,
  profileDigest,
  readCost,
  resolveTemplate,
  resolveView,
  definedViews,
  type PageDocumentRead,
  type PageRead as CompositionPageRead,
  type PresentationProfile,
  type ResolvedTemplate,
  type SelectedContext,
  type View,
  validateDocumentFilters,
  validateProfileFilters,
} from '@rezics/composition';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { readPublicAccountByAgent } from '../access/public-identity.ts';
import {
  AccessUnavailableError,
  classifyUnavailability,
  CommandUnavailableError,
  requireAccessDeadline,
} from '../access/unavailable.ts';
import { cataloguePageMetadata } from './catalogue-page-metadata/index.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError, type FieldError } from '../http/problem-error.ts';
import { SESSION_HEADER } from '../http/request.ts';
import { createBuiltinRuntime } from '../library/builtin-runtime.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../tokens/session.ts';
import { subjectStreams, selectSubjectStream } from './subject-streams.ts';
import type {
  CharacterWorkIdentityOverlay,
  ConfiguredPageRequest,
  CopyWorkDisclosureOverlay,
  PageAccount,
  PageAction,
  PageDocumentRelease,
  PageExecution,
  PageReadResult,
  PageTarget,
  PageViewer,
  PageViewerActions,
  PageWireResult,
  PeopleProducerActionState,
  PublicSemanticPageMetadata,
  SelectedPageSnapshot,
  SemanticPageOverlay,
} from './page-contract.ts';
import { PAGE_GLOBAL_CONTEXT } from './page-contract.ts';
import type { PageApplicationPorts, PageSemanticPort } from './page-semantic-port.ts';
import { PageReadBudget, PageReadError, type PageRead } from './reads.ts';

export type { PageApplicationPorts } from './page-semantic-port.ts';
export {
  PAGE_GLOBAL_CONTEXT,
  type CharacterWorkIdentityOverlay,
  type CopyWorkDisclosureOverlay,
  type PageViewer,
  type PageViewerActions,
  type PublicSemanticPageMetadata,
  type SemanticPageOverlay,
} from './page-contract.ts';

const quotationCorrectionActions = [{ action: 'statement:propose', operationId: 'subject.propose' }] as const;
const peopleProducerCorrectionActions = [
  { action: 'statement:propose', operationId: 'subject.propose' },
  { action: 'context:accept', operationId: 'subject.accept_candidate' },
  { action: 'context:adopt', operationId: 'subject.adopt' },
] as const;
const quotationTextProperties = ['schema:text', 'schema:abstract'] as const;
const recipeInstructionProperties = ['schema:recipeInstructions'] as const;
export const characterWorkType = 'wd:Q95074';
export const appearanceProperty = 'schema:character';
export const identityProperty = 'rezics:relatedCharacterIdentity';
export const appearanceAgeProperty = 'wdt:P3629';
export const spoilerProperty = 'rezics:spoilerLevel';
export const copyWorkProperty = 'schema:exampleOfWork';

function resource() {
  return { route: 0, id: PAGE_GLOBAL_CONTEXT };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reject(errors: FieldError[]): never {
  const sorted = [...errors].sort((left, right) =>
    left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0,
  );
  throw new ProblemError('invalid_request', { errors: sorted });
}

function extendsType(
  release: { types?: Record<string, { bases?: readonly string[] }> } | undefined,
  type: string | null | undefined,
  target: string,
): boolean {
  if (!type || !release?.types?.[target]) return false;
  const seen = new Set<string>();
  const walk = (candidate: string): boolean => {
    if (candidate === target) return true;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return (release.types?.[candidate]?.bases ?? []).some(walk);
  };
  return walk(type);
}

/** Current release admission of schema:Quotation, including descendants. Historical pins omit this type. */
export function quotationTypeAdmitted(
  release: { types?: Record<string, { bases?: readonly string[] }> } | undefined,
  type: string | null | undefined,
): boolean {
  return extendsType(release, type, 'schema:Quotation');
}

/** Current release admission of schema:Recipe, including descendants. Historical pins omit this type. */
export function recipeTypeAdmitted(
  release: { types?: Record<string, { bases?: readonly string[] }> } | undefined,
  type: string | null | undefined,
): boolean {
  return extendsType(release, type, 'schema:Recipe');
}

function overlayDocuments(
  extra: readonly string[],
  base: PageDocumentRead | null,
  subject: string,
  context?: string,
): PageDocumentRead | null {
  if (!extra.length) return base;
  return {
    kind: 'documents',
    id: subject,
    ...(context ? { context } : {}),
    properties: [...new Set([...(base?.properties ?? []), ...extra])].sort(),
  };
}

/** The mounted Character profile renders released authored fields outside the template. */
export function characterPageDocuments(
  port: PageSemanticPort,
  base: PageDocumentRead | null,
  release: PageDocumentRelease | undefined,
  type: string | null,
  subject: string | null,
  available: readonly string[],
  context?: string,
): PageDocumentRead | null {
  if (!subject || !type) return base;
  return overlayDocuments(port.characterDocumentProperties(release, type, available), base, subject, context);
}

/** Generic Recipe templates have no Documents node; hydrate the released instruction document with the page. */
export function recipePageDocuments(
  base: PageDocumentRead | null,
  release: PageDocumentRelease | undefined,
  type: string | null | undefined,
  subject: string | null,
  available: readonly string[],
  context?: string,
): PageDocumentRead | null {
  if (subject === null || !recipeTypeAdmitted(release, type)) return base;
  const extra = recipeInstructionProperties.filter(
    (id) => available.includes(id) && release?.properties?.[id]?.datatype === 'document',
  );
  return overlayDocuments(extra, base, subject, context);
}

/** Ordinary overview Summary hydrates schema:abstract; admitted quotation text still needs the document composition. */
export function quotationPageDocuments(
  base: PageDocumentRead | null,
  release: PageDocumentRelease | undefined,
  type: string | null | undefined,
  subject: string | null,
  available: readonly string[],
  context?: string,
): PageDocumentRead | null {
  if (subject === null || !quotationTypeAdmitted(release, type)) return base;
  const extra = quotationTextProperties.filter(
    (id) => available.includes(id) && release?.properties?.[id]?.datatype === 'document',
  );
  return overlayDocuments(extra, base, subject, context);
}

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

/** Released copy/release-to-work admission for the ordinary edition or release page. */
export function copyWorkDisclosureOverlay(
  release: Pick<Release, 'types' | 'properties'>,
  type: string,
  locale: string,
): CopyWorkDisclosureOverlay | undefined {
  if (!release.types[type]?.properties.includes(copyWorkProperty)) return;
  const property = release.properties[copyWorkProperty];
  const relation = property?.datatype === 'wikibase-item' && property.relation?.group === 'derivation';
  return {
    unavailable: relation ? [] : [{ id: 'copy-work-disclosure', admitted: false }],
    meanings: property ? { [copyWorkProperty]: pickLabel(property.labels, locale) } : {},
  };
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

function survivor(body: unknown): { id: string; type: string } {
  if (!isRecord(body) || !isRecord(body.subject)) throw new Error('Subject read did not return a subject');
  const { id, type } = body.subject;
  if (typeof id !== 'string' || typeof type !== 'string') throw new Error('Subject read did not return a subject');
  return { id, type };
}

function accountOf(body: unknown): {
  id: string;
  kind: string;
  state: string;
  subject: string | null;
  automated: boolean;
  operatorId: string | null;
} | null {
  if (!isRecord(body) || !Array.isArray(body.accounts)) throw new Error('Account read did not return accounts');
  if (body.accounts.length === 0) return null;
  const account = body.accounts[0];
  if (
    !isRecord(account) ||
    typeof account.id !== 'string' ||
    typeof account.kind !== 'string' ||
    typeof account.state !== 'string'
  )
    throw new Error('Account read did not return an account');
  const subject = isRecord(account.subject) && typeof account.subject.id === 'string' ? account.subject.id : null;
  return {
    id: account.id,
    kind: account.kind,
    state: account.state,
    subject,
    automated: account.automated === true,
    operatorId: typeof account.operatorId === 'string' ? account.operatorId : null,
  };
}

function mergedSession(
  ring: PageExecution['tokens'],
  scope: string,
  first: string | null,
  second: string | null,
): string | null {
  if (first === null) return second;
  if (second === null) return first;
  const base = decodeSession(ring, scope, first);
  const extra = decodeSession(ring, scope, second);
  if (!base) return second;
  if (!extra) return first;
  let components: SessionComponent[] = base;
  for (const component of extra) components = mergeSession(components, component);
  return encodeSession(ring, scope, components);
}

function wire(
  status: number,
  body: unknown,
  session: string | null,
  nativeHeaders?: Record<string, string>,
): PageWireResult {
  return {
    status,
    body,
    session,
    ...(nativeHeaders?.['retry-after'] ? { retryAfter: nativeHeaders['retry-after'] } : {}),
  };
}

export type PageApplication = Readonly<{
  ports: PageApplicationPorts;
  characterPageDocuments: (
    base: PageDocumentRead | null,
    release: PageDocumentRelease | undefined,
    type: string | null,
    subject: string | null,
    available: readonly string[],
    context?: string,
  ) => PageDocumentRead | null;
  recipePageDocuments: typeof recipePageDocuments;
  quotationPageDocuments: typeof quotationPageDocuments;
  quotationTypeAdmitted: typeof quotationTypeAdmitted;
  recipeTypeAdmitted: typeof recipeTypeAdmitted;
  characterWorkIdentityOverlay: typeof characterWorkIdentityOverlay;
  copyWorkDisclosureOverlay: typeof copyWorkDisclosureOverlay;
  semanticPageView: typeof semanticPageView;
  pageViewerActions: typeof pageViewerActions;
  readQuotationPageAuthority(deps: {
    pool: Pool;
    access: Access;
    actor: Actor;
    deadline: number;
  }): Promise<{ viewer: PageViewer; actions: PageAction[] }>;
  readPeopleProducerPageAuthority(
    deps: { access: Access; pool: Pool },
    actor: Actor,
    deadline: number,
  ): Promise<{
    viewer: { kind: 'anonymous' | 'account' };
    actions: { action: string; operationId: string; state: PeopleProducerActionState }[];
  }>;
  preparePublicSemanticPageMetadata(
    deps: {
      pool: Pool;
      access: Access;
      deadline: number;
    },
    ids: readonly string[],
  ): Promise<{ finish(): Promise<Map<string, PublicSemanticPageMetadata | null>> }>;
  activeProfile: PageApplicationPorts['profiles']['activeProfile'];
  readProfile: PageApplicationPorts['profiles']['readProfile'];
  publishProfile: PageApplicationPorts['profiles']['publishProfile'];
  activateProfile: PageApplicationPorts['profiles']['activateProfile'];
  bootstrapProfile: PageApplicationPorts['profiles']['bootstrapProfile'];
  selectPage: PageApplicationPorts['selected']['selectPage'];
  guardSelectedPage: PageApplicationPorts['selected']['guardSelectedPage'];
  readConfiguredPage(request: ConfiguredPageRequest): Promise<PageWireResult>;
}>;

async function readQuotationPageAuthority(deps: {
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
      { route: 0, id: PAGE_GLOBAL_CONTEXT },
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

async function readPeopleProducerPageAuthority(
  ports: PageApplicationPorts,
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
          { route: 0, id: PAGE_GLOBAL_CONTEXT },
          { pool: deps.pool, deadline },
        ),
      })),
    );
    requireAccessDeadline(deadline);
    const actions = await ports.semantic.withReadTransaction(
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

async function preparePublicSemanticPageMetadata(
  application: PageApplication,
  ports: PageApplicationPorts,
  deps: { pool: Pool; access: Access; deadline: number },
  ids: readonly string[],
) {
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
    const gates = await Promise.all(
      (['presentation:read', 'subject:read'] as const).map((action) =>
        accessCheck(
          deps.access,
          actor,
          action,
          {
            route: 0,
            id: PAGE_GLOBAL_CONTEXT,
            eligibility: ports.semantic.globalReadEligibility(action) as never,
          },
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
    const global = await ports.semantic.withReadTransaction(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deps.deadline);
      const epoch = await anchor(client, 0);
      let allowed = true;
      for (const gate of gates) if (!(await gate(client))) allowed = false;
      return { epoch, allowed };
    });
    const profile = await application.activeProfile(deps.pool);
    const release = await ports.semantic.activeRelease(deps.pool);
    const rows = new Map<
      string,
      {
        state: Awaited<ReturnType<PageSemanticPort['readSubjectPageStates']>>[number];
        detail: Awaited<ReturnType<PageSemanticPort['readItemDetails']>> extends Map<string, infer T> ? T : never;
        epoch: number;
        allowed: boolean;
      }
    >();
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
                      eligibility: ports.semantic.relatedReadEligibility({ route: routeOf(id)!, id }, group) as never,
                    },
                    { pool: deps.pool, deadline: deps.deadline },
                  ),
                ] as const,
            ),
          ),
        );
        await ports.semantic.withReadTransaction(deps.pool, async (connection) => {
          const client = deadlineClient({ query: connection.query.bind(connection) }, deps.deadline);
          const epoch = await anchor(client, home);
          const states = await ports.semantic.readSubjectPageStates(client, home, group);
          const details = await ports.semantic.readItemDetails(client, group);
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
        if (
          !old?.allowed ||
          !row?.allowed ||
          JSON.stringify(old) !== JSON.stringify(row) ||
          row.state.visibility !== 'visible' ||
          row.state.redirect
        )
          continue;
        const page = application.semanticPageView(current.profile.profile, current.release.release, row.detail.type);
        if (page) result.set(id, { views: page.views, independentSubject: row.detail.agentAccountId === null });
      }
      return result;
    },
  };
}

async function answerPage(
  application: PageApplication,
  ports: PageApplicationPorts,
  input: {
    release: import('@rezics/filter').FilterRelease | undefined;
    continuationOnlyLists: boolean;
    execution: PageExecution;
    session: { ring: PageExecution['tokens']; scope: string };
    digest: string;
    draft?: { digest: string; target: PageTarget; advice: 'allowed' };
    resolved: ResolvedTemplate;
    views: View[] | null;
    subject: string | null;
    subjectType: string | null;
    account: PageAccount | null;
    probes: Map<string, PageReadResult>;
    budget: PageReadBudget;
    probeSession: string | null;
    languages?: readonly string[];
    context?: SelectedContext;
    board?: string;
    continuation?: ConfiguredPageRequest['continuation'];
    stream?: string;
    finalGuard?: (session: string | null) => Promise<string | null>;
    catalogue?: ReturnType<typeof cataloguePageMetadata>;
    overlay?: SemanticPageOverlay;
    viewer?: () => Promise<{
      state: 'anonymous' | 'account';
      account?: string;
      context: string;
      actions: { statementPropose: 'allowed' | 'denied' | 'unavailable' };
    }>;
  },
): Promise<PageWireResult> {
  const violations = validateDocumentFilters(
    platformRegistry,
    input.resolved.document,
    input.release ?? { types: {}, properties: {} },
  );
  if (violations.length)
    throw new ProblemError('invalid_request', {
      errors: violations.map(({ pointer, code }) => ({
        pointer,
        code: code === 'limit' ? 'out_of_range' : 'unsupported',
      })),
    });
  const plan = (() => {
    try {
      return planReads(platformRegistry, input.resolved.document, {
        subject: input.subject,
        account: input.account,
        ...(input.context ? { context: input.context } : {}),
        ...(input.board ? { board: input.board } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
      });
    } catch (error) {
      if (error instanceof PageContinuationError)
        reject([{ pointer: `/continuation/${error.field}`, code: 'invalid_format' }]);
      if (error instanceof PageReadLimitError) reject([{ pointer: '/reads', code: 'out_of_range' }]);
      throw error;
    }
  })();
  if (
    input.continuation &&
    input.continuationOnlyLists &&
    plan.reads[plan.nodes[input.continuation.node]!]?.kind !== 'search' &&
    plan.reads[plan.nodes[input.continuation.node]!]?.kind !== 'members'
  )
    reject([{ pointer: '/continuation', code: 'unsupported' }]);
  if (Object.values(plan.reads).reduce((cost, read) => cost + readCost(read), 0) > MAX_PAGE_COST)
    reject([{ pointer: '/reads', code: 'out_of_range' }]);
  const observed = new Map(input.probes);
  const context = input.context ? { context: input.context.id } : {};
  const observation = observed.get(canonicalize({ kind: 'subject', id: input.subject, ...context })!);
  const subjectBody = observation?.status === 200 && isRecord(observation.body) ? observation.body.subject : undefined;
  const streams = !input.continuationOnlyLists
    ? selectSubjectStream(
        subjectStreams(input.resolved.document, {
          subject: input.subject,
          account: input.account,
          ...(input.context ? { context: input.context } : {}),
        }),
        input.stream,
        input.continuation?.node,
        isRecord(subjectBody) ? (subjectBody.relationCounts as Record<string, number> | undefined) : undefined,
      )
    : undefined;
  if (input.stream && !streams?.entries.some(({ node }) => node === input.stream))
    reject([{ pointer: '/stream', code: 'invalid_format' }]);
  const continuedKey = streams?.selected
    ? plan.nodes[streams.selected]
    : input.continuation
      ? plan.nodes[input.continuation.node]
      : undefined;
  for (const [readKey, descriptor] of Object.entries(plan.reads)) {
    const key = canonicalize(descriptor)!;
    if (
      continuedKey &&
      readKey !== continuedKey &&
      (descriptor.kind === 'links' ||
        descriptor.kind === 'relations' ||
        descriptor.kind === 'members' ||
        descriptor.kind === 'search' ||
        descriptor.kind === 'subjectThreads')
    ) {
      observed.set(key, { status: 204, body: {} });
      continue;
    }
    if (
      input.context?.population.kind === 'realm' &&
      (descriptor.kind === 'collections' ||
        descriptor.kind === 'reactions' ||
        descriptor.kind === 'search' ||
        descriptor.kind === 'members')
    )
      observed.set(canonicalize(descriptor)!, { status: 503, body: { code: 'dependency_unavailable' } });
  }
  const properties =
    isRecord(subjectBody) && isRecord(subjectBody.statements) ? Object.keys(subjectBody.statements) : [];
  const documents = recipePageDocuments(
    quotationPageDocuments(
      application.characterPageDocuments(
        documentRead(input.resolved.document, input.subject, properties, input.context?.id),
        input.release,
        input.subjectType,
        input.subject,
        properties,
        input.context?.id,
      ),
      input.release,
      input.subjectType,
      input.subject,
      properties,
      input.context?.id,
    ),
    input.release,
    input.subjectType,
    input.subject,
    properties,
    input.context?.id,
  );
  const incoming = new Request(input.execution.request.url, {
    headers: input.execution.request.headers,
    signal: input.execution.request.signal,
  });
  const forwarded = mergedSession(
    input.session.ring,
    input.session.scope,
    incoming.headers.get(SESSION_HEADER),
    input.probeSession,
  );
  if (forwarded !== null) incoming.headers.set(SESSION_HEADER, forwarded);
  let page;
  let releaseGuard: (() => void) | undefined;
  try {
    releaseGuard = input.finalGuard ? input.budget.reserve(1, 1) : undefined;
    page = await ports.pageRead.readPage({
      dispatch: input.execution.dispatch,
      resolveBuiltin: async (key) => {
        if (
          input.execution.actor.kind !== 'account' ||
          (input.account !== null && input.account.id !== input.execution.actor.accountId)
        )
          return null;
        return input.execution.run(() =>
          createBuiltinRuntime({ pool: input.execution.pool }).resolve(
            input.execution.actor as Extract<Actor, { kind: 'account' }>,
            key,
            input.execution.deadline,
          ),
        );
      },
      incoming,
      reads: plan.reads as Record<string, PageRead>,
      session: input.session,
      observed,
      budget: input.budget,
      ...(documents ? { documents } : {}),
      ...(input.languages === undefined ? {} : { languages: input.languages }),
    });
  } catch (error) {
    if (error instanceof PageReadError) reject(error.errors);
    throw error;
  } finally {
    releaseGuard?.();
  }
  let readSession = mergedSession(input.session.ring, input.session.scope, input.probeSession, page.session);
  if (input.finalGuard) {
    const guarded = await input.finalGuard(readSession);
    readSession = mergedSession(input.session.ring, input.session.scope, readSession, guarded);
  }
  const reads: Record<string, PageReadResult> = {};
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    let result = page.results[key];
    if (
      result?.status === 200 &&
      descriptor.kind === 'subject' &&
      descriptor.id === input.subject &&
      isRecord(result.body) &&
      Object.keys(page.documents).length > 0
    )
      result = { ...result, body: { ...result.body, documents: page.documents } };
    if (!result) throw new Error('Page read did not return a result');
    if (descriptor.kind === 'subject' && descriptor.id === input.subject && result.status !== 200) {
      return wire(result.status, result.body, readSession, result.headers);
    }
    reads[key] =
      input.account === null &&
      descriptor.kind === 'subject' &&
      descriptor.id === input.subject &&
      isRecord(result.body)
        ? { ...result, body: { ...result.body, account: null } }
        : result;
  }

  const catalogueViewer = input.viewer ? await input.viewer() : undefined;
  const subjectViewer =
    catalogueViewer === undefined && input.subject !== null
      ? input.execution.actor.kind === 'account'
        ? { kind: 'account' as const, account: input.execution.actor.accountId }
        : { kind: 'anonymous' as const }
      : undefined;
  let viewerEnvelope: ReturnType<typeof pageViewerActions> | undefined;
  if (input.subject) {
    const composed = Object.entries(plan.reads).find(
      ([, descriptor]) => descriptor.kind === 'subject' && descriptor.id === input.subject,
    );
    const composedBody = composed ? reads[composed[0]!] : undefined;
    const type =
      composedBody?.status === 200 &&
      isRecord(composedBody.body) &&
      isRecord(composedBody.body.subject) &&
      typeof composedBody.body.subject.type === 'string'
        ? composedBody.body.subject.type
        : undefined;
    if (type && !quotationTypeAdmitted(input.release, input.subjectType)) {
      try {
        input.budget.charge(1);
        const headers = new Headers(incoming.headers);
        headers.set('content-type', 'application/json');
        if (readSession !== null) headers.set(SESSION_HEADER, readSession);
        const viewerResponse = await input.execution.dispatch(
          new Request(new URL('/v1/viewerActions', input.execution.request.url), {
            method: 'POST',
            headers,
            body: JSON.stringify({ resources: [{ type, id: input.subject }] }),
            signal: input.execution.request.signal,
          }),
        );
        const text = await viewerResponse.text();
        viewerEnvelope = pageViewerActions(type, input.subject, {
          status: viewerResponse.status,
          body: text === '' ? null : (JSON.parse(text) as unknown),
        });
        readSession = mergedSession(
          input.session.ring,
          input.session.scope,
          readSession,
          viewerResponse.headers.get(SESSION_HEADER),
        );
      } catch (error) {
        if (error instanceof PageReadError || error instanceof SyntaxError)
          viewerEnvelope = pageViewerActions(type, input.subject, { status: 503, body: null });
        else throw error;
      }
    }
  }

  const quotationAuthority =
    input.subject !== null && quotationTypeAdmitted(input.release, input.subjectType)
      ? await application.readQuotationPageAuthority({
          pool: input.execution.pool,
          access: input.execution.access,
          actor: input.execution.actor,
          deadline: input.execution.deadline,
        })
      : null;

  return wire(
    200,
    {
      ...(input.subject === null ? {} : { subject: input.subject }),
      ...(input.account === null ? {} : { account: input.account.id }),
      ...(input.context ? { context: input.context } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
      ...(streams ? { streams } : {}),
      profile: input.digest,
      ...(input.draft ? { draft: input.draft } : {}),
      template: { scope: input.resolved.scope, key: input.resolved.key },
      document: input.resolved.document,
      ...(input.views === null ? {} : { views: input.views }),
      ...(input.catalogue ? { catalogue: input.catalogue } : {}),
      ...(catalogueViewer ? { viewer: catalogueViewer } : {}),
      ...(subjectViewer ? { viewer: subjectViewer } : {}),
      ...(quotationAuthority ? { viewer: quotationAuthority.viewer } : {}),
      reads,
      ...(input.overlay ? { meanings: input.overlay.meanings, unavailable: input.overlay.unavailable } : {}),
      ...(quotationAuthority
        ? { actions: quotationAuthority.actions }
        : viewerEnvelope
          ? { actions: viewerEnvelope.actions }
          : {}),
    },
    readSession,
  );
}

async function readConfiguredPage(
  application: PageApplication,
  ports: PageApplicationPorts,
  request: ConfiguredPageRequest,
): Promise<PageWireResult> {
  const { execution, target, continuation, stream } = request;
  const languages = request.languages;
  const actor = execution.actor;
  const pool = execution.pool;
  const tokens = execution.tokens;
  const draftPreview = execution.draftPreview;
  const captured = execution.capturedProfile;
  const includeEligibility = execution.includeEligibility;
  const active = await execution.run(async () => {
    if (!(await withConnection(pool, (client) => execution.admit(client))))
      throw new ProblemError(draftPreview ? 'forbidden' : 'not_found');
    if (!captured) return application.activeProfile(pool);
    const readResource = {
      ...resource(),
      ...(includeEligibility
        ? { eligibility: ports.semantic.globalReadEligibility('presentation:read') as never }
        : {}),
    };
    for (const reader of execution.draftReaders ?? [actor]) {
      const readCheck = await accessCheck(execution.access, reader, 'presentation:read', readResource, {
        pool,
        deadline: execution.deadline,
      });
      if (!(await withConnection(pool, (client) => readCheck(client)))) throw new ProblemError('forbidden');
    }
    const release = await ports.semantic.activeRelease(pool);
    const violations = validateProfileFilters(
      platformRegistry,
      captured,
      release?.release ?? { types: {}, properties: {} },
    );
    if (violations.length)
      reject(
        violations.map(({ pointer, code }) => ({
          pointer: `/profile${pointer}`,
          code: code === 'limit' ? 'out_of_range' : 'unsupported',
        })),
      );
    if ('route' in target && !captured.routes.some((entry) => entry.route === target.route))
      reject([{ pointer: '/target/route', code: 'unsupported' }]);
    return { digest: profileDigest(captured), profile: captured };
  });
  if (!active) throw new ProblemError('presentation_not_ready', { headers: { 'retry-after': '1' } });

  const scope = actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous';
  const session = { ring: tokens, scope };
  const budget = ports.pageRead.createBudget();
  const probes = new Map<string, PageReadResult>();
  let probeSession: string | null = null;
  const probe = async (descriptor: CompositionPageRead): Promise<PageReadResult> => {
    const incoming = new Request(execution.request.url, {
      headers: execution.request.headers,
      signal: execution.request.signal,
    });
    const forwarded = mergedSession(tokens, scope, incoming.headers.get(SESSION_HEADER), probeSession);
    if (forwarded !== null) incoming.headers.set(SESSION_HEADER, forwarded);
    const probed = await ports.pageRead.readPage({
      dispatch: execution.dispatch,
      incoming,
      reads: { probe: descriptor as PageRead },
      session,
      budget,
      ...(languages ? { languages } : {}),
    });
    probeSession = mergedSession(tokens, scope, probeSession, probed.session);
    const result = probed.results.probe!;
    probes.set(canonicalize(descriptor)!, result);
    return result;
  };
  let selected: SelectedPageSnapshot | undefined;
  const subjectProbe = async (id: string) => {
    const context = selected ? { context: selected.context.id } : {};
    const result = await probe({ kind: 'subject', id, ...context });
    if (result.status !== 200) return { failed: result } as const;
    const found = survivor(result.body);
    probes.set(canonicalize({ kind: 'subject', id: found.id, ...context })!, result);
    return { subject: found } as const;
  };
  let subject: { id: string; type: string } | null = null;
  let account: PageAccount | null = null;
  let resolved: ResolvedTemplate;
  let views: View[] | null = null;
  const definitionRelease = await ports.semantic.activeRelease(pool);
  if ('route' in target) {
    resolved = resolveTemplate(active.profile, { route: target.route });
  } else {
    const release = definitionRelease;
    let subjectTarget: string | null = null;
    let kind = 'actor';
    let automated = false;
    if ('subject' in target) {
      subjectTarget = target.subject;
      if (target.realm) {
        const types = await execution.run(() =>
          withConnection(pool, (client) =>
            ports.semantic.readItemTypes(deadlineClient(client, execution.deadline), [target.subject]),
          ),
        );
        const roots = new Set(['schema:Person', 'schema:Organization', 'schema:SoftwareApplication']);
        const visited = new Set<string>();
        const agentType = (type: string): boolean => {
          if (roots.has(type)) return true;
          if (visited.has(type)) return false;
          visited.add(type);
          return (release?.release.types[type]?.bases ?? []).some(agentType);
        };
        const type = types.get(target.subject);
        if (!type || !agentType(type)) selected = await application.selectPage(execution, target.realm, subjectTarget);
      }
    } else {
      const result = await probe({ kind: 'account', handle: target.account });
      if (result.status !== 200) return wire(result.status, result.body, probeSession, result.headers);
      const found = accountOf(result.body);
      if (found === null || found.state !== 'active') throw new ProblemError('not_found');
      account = { id: found.id, handle: target.account, automated: found.automated, operatorId: found.operatorId };
      subjectTarget = found.subject;
      kind = found.kind;
      automated = found.automated;
    }
    if (subjectTarget !== null) {
      const probed = await subjectProbe(subjectTarget);
      if ('failed' in probed)
        return wire(probed.failed.status, probed.failed.body, probeSession, probed.failed.headers);
      subject = probed.subject;
      if ('subject' in target) {
        const [agent] = await execution.run(() => readPublicAccountByAgent(pool, probed.subject.id));
        if (agent && agent.state !== 'deleted' && agent.handle !== null) {
          return {
            status: 308,
            body: { redirect: { from: target.subject, to: agent.handle } },
            session: probeSession,
            redirectAccount: { handle: agent.handle, ...(target.view ? { view: target.view } : {}) },
          };
        }
      }
    }
    const type =
      subject?.type ??
      (kind === 'organization' ? 'schema:Organization' : automated ? 'schema:SoftwareApplication' : 'schema:Person');
    const page = application.semanticPageView(active.profile, release?.release, type, target.view ?? 'overview');
    if (page === null) throw new ProblemError('not_found');
    resolved = page.resolved;
    views = page.views;
  }

  probeSession = mergedSession(
    tokens,
    scope,
    probeSession,
    encodeSession(tokens, scope, execution.sessionComponents()),
  );
  const initialSubjectDescriptor = subject
    ? { kind: 'subject' as const, id: subject.id, ...(selected ? { context: selected.context.id } : {}) }
    : undefined;
  const initialSubject = initialSubjectDescriptor
    ? probes.get(canonicalize(initialSubjectDescriptor)!)?.body
    : undefined;
  const properties =
    isRecord(initialSubject) && isRecord(initialSubject.subject) && isRecord(initialSubject.subject.statements)
      ? Object.keys(initialSubject.subject.statements)
      : [];
  const plannedDocuments = documentRead(resolved.document, subject?.id ?? null, properties, selected?.context.id);
  const pageCatalogue = subject
    ? cataloguePageMetadata(definitionRelease?.release, definitionRelease?.digest, subject.type)
    : undefined;
  const identityOverlay =
    subject && definitionRelease?.release
      ? (application.characterWorkIdentityOverlay(definitionRelease.release, subject.type, languages?.[0] ?? 'en') ??
        application.copyWorkDisclosureOverlay(definitionRelease.release, subject.type, languages?.[0] ?? 'en'))
      : undefined;
  const pageViewer =
    pageCatalogue?.state === 'released' || identityOverlay
      ? async () => {
          let statementPropose: 'allowed' | 'denied' | 'unavailable';
          try {
            const check = await accessCheck(execution.access, actor, 'statement:propose', resource(), {
              pool,
              deadline: execution.deadline,
            });
            statementPropose = (await execution.run(() => withConnection(pool, (client) => check(client))))
              ? 'allowed'
              : 'denied';
          } catch (error) {
            if (!(error instanceof AccessUnavailableError)) throw error;
            statementPropose = 'unavailable';
          }
          return {
            state: actor.kind === 'account' ? ('account' as const) : ('anonymous' as const),
            ...(actor.kind === 'account' ? { account: actor.accountId } : {}),
            context: selected?.context.id ?? PAGE_GLOBAL_CONTEXT,
            actions: { statementPropose },
          };
        }
      : undefined;
  return answerPage(application, ports, {
    release: definitionRelease?.release,
    continuationOnlyLists: !('subject' in target) || !target.view || target.view === 'overview',
    execution,
    session,
    digest: active.digest,
    ...(draftPreview ? { draft: { digest: active.digest, target, advice: 'allowed' as const } } : {}),
    ...(pageCatalogue ? { catalogue: pageCatalogue } : {}),
    ...(pageViewer ? { viewer: pageViewer } : {}),
    ...(identityOverlay ? { overlay: identityOverlay } : {}),
    resolved,
    views,
    subject: subject?.id ?? null,
    subjectType: subject?.type ?? null,
    account,
    probes,
    budget,
    probeSession,
    ...(languages === undefined ? {} : { languages }),
    ...(selected ? { context: selected.context } : {}),
    ...('subject' in target && target.board ? { board: target.board } : {}),
    ...(continuation ? { continuation } : {}),
    ...(stream ? { stream } : {}),
    ...(selected || plannedDocuments
      ? {
          finalGuard: async (readSession: string | null) => {
            const incoming = new Request(execution.request, { headers: execution.request.headers });
            if (readSession !== null) incoming.headers.set(SESSION_HEADER, readSession);
            const descriptor = {
              kind: 'subject' as const,
              id: subject!.id,
              ...(selected ? { context: selected.context.id } : {}),
            };
            const current = await ports.pageRead.readPage({
              dispatch: execution.dispatch,
              incoming,
              reads: { guard: descriptor },
              session,
              budget,
              ...(languages ? { languages } : {}),
            });
            probeSession = mergedSession(tokens, scope, probeSession, current.session);
            const result = current.results.guard!;
            if (result.status !== 200)
              throw new ProblemError(result.status === 404 ? 'not_found' : 'dependency_unavailable', {
                headers: { 'retry-after': '1' },
              });
            const initial = probes.get(canonicalize(descriptor)!);
            if (survivor(result.body).id !== subject!.id || canonicalize(result.body) !== canonicalize(initial?.body))
              throw new ProblemError('dependency_unavailable', { headers: { 'retry-after': '1' } });
            if (selected) await application.guardSelectedPage(execution, selected);
            return mergedSession(
              tokens,
              scope,
              current.session,
              encodeSession(tokens, scope, execution.sessionComponents()),
            );
          },
        }
      : {}),
  });
}

/** One constructed instance owns page-answer, profile selection and Semantic page-metadata orchestration. */
export function createPageApplication(ports: PageApplicationPorts): PageApplication {
  const application = {
    ports,
    characterPageDocuments: (
      base: PageDocumentRead | null,
      release: PageDocumentRelease | undefined,
      type: string | null,
      subject: string | null,
      available: readonly string[],
      context?: string,
    ) => characterPageDocuments(ports.semantic, base, release, type, subject, available, context),
    recipePageDocuments,
    quotationPageDocuments,
    quotationTypeAdmitted,
    recipeTypeAdmitted,
    characterWorkIdentityOverlay,
    copyWorkDisclosureOverlay,
    semanticPageView,
    pageViewerActions,
    readQuotationPageAuthority,
    readPeopleProducerPageAuthority: (deps: { access: Access; pool: Pool }, actor: Actor, deadline: number) =>
      readPeopleProducerPageAuthority(ports, deps, actor, deadline),
    preparePublicSemanticPageMetadata: (
      deps: { pool: Pool; access: Access; deadline: number },
      ids: readonly string[],
    ) => preparePublicSemanticPageMetadata(application, ports, deps, ids),
    activeProfile: (pool: Pool) => ports.profiles.activeProfile(pool),
    readProfile: (pool: Parameters<PageApplicationPorts['profiles']['readProfile']>[0], digest: string) =>
      ports.profiles.readProfile(pool, digest),
    publishProfile: ports.profiles.publishProfile,
    activateProfile: ports.profiles.activateProfile,
    bootstrapProfile: (pool: Pool, profile: PresentationProfile) => ports.profiles.bootstrapProfile(pool, profile),
    selectPage: (execution: PageExecution, realmId: string, subject: string) =>
      ports.selected.selectPage(execution, realmId, subject),
    guardSelectedPage: (execution: PageExecution, selected: SelectedPageSnapshot) =>
      ports.selected.guardSelectedPage(execution, selected),
    readConfiguredPage: (request: ConfiguredPageRequest) => readConfiguredPage(application, ports, request),
  } as PageApplication;
  return Object.freeze(application);
}

let installed: PageApplication | undefined;

/** Composition installs the native producers; module evaluation installs nothing. */
export function bindPageApplication(application: PageApplication): PageApplication {
  installed = application;
  return application;
}

export function presentationApplication(): PageApplication {
  if (!installed) throw new TypeError('Presentation page application is not installed');
  return installed;
}

export function tryPresentationApplication(): PageApplication | undefined {
  return installed;
}

export function unbindPageApplication(): void {
  installed = undefined;
}
