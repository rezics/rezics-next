import { AsyncLocalStorage } from 'node:async_hooks';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { readAddress } from '../../../../../apps/web/features/address/client.ts';
import { realmFrameReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import { readSpacePage } from '../../../../../apps/web/features/address/space-read.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordJapaneseReads } from '../../../support/recorded-locale-visit.ts';
import { closeRealm, closureCell } from './closure-fixture.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fromPlainText } from '@rezics/document';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-direct-routes.ts';
import {
  personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(180_000);
const recording = recordJapaneseReads(new OutcomeRecorder(declaration));
let closed: PersonaSessions;
let live: PersonaSessions;
let privateRealm: PersonaSessions;
let setupFailure: string | null = null;
let closureFailure: string | null = null;
let privateClosureFailure: string | null = null;
let adopted: Awaited<ReturnType<typeof publish>>;
let liveAdoption: Awaited<ReturnType<typeof publish>>;
const absentRealm = `https://rezics.com/id/${randomUUID()}`;
const before = new Map<string, Answer>();
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
const root = (sessions: PersonaSessions) => `/v1/realms/${short(sessions.realm)}`;

/** Observe the real setup transport, including attempts that never answer.
 * Account credentials and verification query strings are not retained. */
function recordSetupRequests() {
  const original = globalThis.fetch;
  const runId = Bun.env.REZICS_QA_RUN_ID ?? randomUUID();
  mkdirSync('.temp/goal', { recursive: true });
  const file = `.temp/goal/${runId}-direct-route-setup.jsonl`;
  const mainOrigin = `http://127.0.0.1:${Bun.env.MAIN_PORT}`;
  const accountOrigin = `http://127.0.0.1:${Bun.env.ACCOUNT_PORT}`;
  const record = (value: object) => {
    const raw = JSON.stringify(value);
    appendFileSync(file, `${raw}\n`);
    console.log('Realm direct-route setup timing', raw);
  };
  let ordinal = 0;
  const setupStarted = performance.now();
  record({ event: 'setup-start', at: new Date().toISOString(), runId, file });
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const main = url.origin === mainOrigin;
    if (!main && url.origin !== accountOrigin && !url.pathname.startsWith('/api/v1/')) {
      return original(...args);
    }
    const id = ++ordinal;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = main ? url.pathname + url.search : url.pathname;
    const request = { id, method, origin: url.origin, path, startedAt,
      ...(main ? { key: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        .get('idempotency-key') } : {}),
      ...(main && typeof init?.body === 'string' ? { body: init.body } : {}) };
    record({ event: 'request-start', ...request });
    try {
      const response = await original(...args);
      const body = main && response.headers.get('content-type')?.includes('json')
        ? await response.clone().text() : null;
      record({ event: 'request-end', ...request, endedAt: new Date().toISOString(),
        durationMs: performance.now() - started, status: response.status, answer: body });
      return response;
    } catch (error) {
      record({ event: 'request-end', ...request, endedAt: new Date().toISOString(),
        durationMs: performance.now() - started, status: null, error: String(error) });
      throw error;
    }
  }, { preconnect: original.preconnect });
  return () => {
    globalThis.fetch = original;
    record({ event: 'setup-end', at: new Date().toISOString(), durationMs: performance.now() - setupStarted });
  };
}

type Answer = { status: number; body: string };
async function observe(person: PersonaSession, path: string): Promise<Answer> {
  const response = await person.main('GET', path);
  return { status: response.status, body: await response.text() };
}
async function command<T>(
  person: PersonaSession, method: string, path: string, body?: unknown,
  status = 200, key?: string,
): Promise<T> {
  const response = await person.main(method, path, body, key);
  const raw = await response.text();
  if (response.status !== status)
    throw new Error(`${method} ${path}: expected ${status}, received ${response.status} ${raw}`);
  return JSON.parse(raw) as T;
}

function concealed(failures: string[], path: string, answer: Answer, absent: Answer) {
  if (answer.status !== absent.status || JSON.stringify(JSON.parse(answer.body)) !==
      JSON.stringify(JSON.parse(absent.body))) {
    failures.push(`GET ${path}: ${answer.status} ${answer.body}; absent: ${absent.status} ${absent.body}`);
  }
}
function reportFailures(failures: string[]) {
  if (failures.length) console.log(failures.join('\n'));
  expect(failures, failures.join('\n')).toEqual([]);
}

type Work = { work: string; mainVersion: string; workRevision: string };
async function publish(sessions: PersonaSessions, adopt: boolean) {
  const owner = sessions.owner;
  const work = await command<Work>(owner, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Independent original closure control',
    language: 'en', authoring: 'own-work', actingSubject: owner.actingSubject,
  }, 201);
  const draft = await command<{ contribution: string; draftRevision: string }>(
    owner, 'POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'An original fixture story by the owner Person, published independently.',
      actingSubject: owner.actingSubject,
    }, 201,
  );
  const publication = await command<{ publicationDecision: string }>(
    owner, 'POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject,
    }, 201,
  );
  const selection = { work: work.work, contribution: draft.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    actingSubject: owner.actingSubject };
  await command(owner, 'POST', '/v1/publication-selections', {
    ...selection, profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: work.mainVersion },
    selectionBasis: 'main-maintainer',
  }, 201);
  let decision: string | null = null;
  if (adopt) {
    await role(sessions, ['publication.adopt'], owner);
    decision = (await command<{ selection: string }>(
      owner, 'POST', '/v1/publication-selections', {
        ...selection, profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm }, mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }, 201,
    )).selection;
  }
  return { ...work, decision };
}
async function role(sessions: PersonaSessions, permissions: string[], holder: PersonaSession) {
  const owner = sessions.owner;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Fixture publishers and reviewers', permissions },
    { kind: 'assignment', roleId, member: holder.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const basis = await command<{ generation: string }>(owner, 'GET',
      `${root(sessions)}/roles?${acting(owner)}`);
    const input = { actingSubject: owner.actingSubject, expectedGeneration: basis.generation,
      reason: 'Publish original closure controls', change };
    const impact = await command<{ digest: string }>(
      owner, 'POST', `${root(sessions)}/role-impact`, input);
    await command(owner, 'POST', `${root(sessions)}/role-changes`,
      { ...input, impactDigest: impact.digest }, 201);
  }
}

async function publishSite(sessions: PersonaSessions) {
  const owner = sessions.owner;
  const path = `/v1/zones/${short(sessions.zone)}`;
  const current = await command<{ revision: string }>(owner, 'GET', `${path}/configuration?${acting(owner)}`);
  await command(owner, 'PUT', `${path}/configuration`, {
    expectedHead: current.revision, prepareHomeDocument: true, actingSubject: owner.actingSubject,
  });
  const configuration = await command<{ revision: string; configuration: { homeDocument: string } }>(
    owner, 'GET', `${path}/configuration?${acting(owner)}`);
  const navigation = await command<{ revision: string }>(owner, 'GET', `${path}?${acting(owner)}`);
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner, 'POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: configuration.configuration.homeDocument,
      variantId, expectedHead: null,
      document: fromPlainText('An original published home for the Realm entry control.', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      actingSubject: owner.actingSubject,
    }, 201,
  );
  await command(owner, 'POST', `${path}/site-publications`, {
    expectedHead: configuration.revision, actingSubject: owner.actingSubject,
    routesRevision: navigation.revision, navigationRevision: navigation.revision,
    pages: [{ page: configuration.configuration.homeDocument, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }, 201, randomUUID());
}

// Setup uses public commands. A product refusal remains an explicit pending
// prerequisite; OAuth/application failures escape beforeAll as infrastructure errors.
beforeAll(async () => {
  await recording.prepare();
  const finishRecording = recordSetupRequests();
  try {
    // Each fixture drains the shared verification mailbox before opening its owner session.
    closed = await personaSessions('public');
    live = await personaSessions('public');
    privateRealm = await personaSessions('private');
    try {
      const prepareControl = async (fixture: PersonaSessions) => {
        // personaSessions creates a Zone Space and attaches it through the
        // public configuration API. Its owner is the Realm's owner Person.
        const config = await command<{ configuration: { defaultRealm: string } }>(fixture.owner, 'GET',
          `/v1/zones/${short(fixture.zone)}/configuration?${acting(fixture.owner)}`);
        expect(config.configuration.defaultRealm).toBe(fixture.realm);
        const [publication] = await Promise.all([publish(fixture, true), publishSite(fixture)]);
        return publication;
      };
      const privateSettings = (async () => {
        const owner = privateRealm.owner;
        const settings = await command<{ generation: string }>(owner, 'GET',
          `/v1/spaces/${short(privateRealm.space)}/settings?${acting(owner)}`);
        await command(owner, 'PUT', `/v1/spaces/${short(privateRealm.space)}/settings`, {
          actingSubject: owner.actingSubject, expectedGeneration: settings.generation,
          settings: { visibility: 'private', listing: 'listed', admission: 'request', history: 'everything' },
          reason: 'Retain a private request-admission teaser control',
        }, 201);
      })();
      [adopted, liveAdoption] = await Promise.all([
        prepareControl(closed), prepareControl(live), privateSettings,
      ]);
      for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
        for (const path of paths(closed, adopted.decision!, closed[name]))
          before.set(`${name}:${path}`, await observe(closed[name], path));
        const teaser = `${root(privateRealm)}/join-page?${acting(privateRealm[name])}`;
        before.set(`${name}:${teaser}`, await observe(privateRealm[name], teaser));
      }
    } catch (error) { setupFailure = String(error); }
    // Both closures share the operator's grant epoch; keep that chain ordered.
    // Closure commands are independent of adoption/teaser setup.
    closureFailure = await closeRealm(closed);
    privateClosureFailure = await closeRealm(privateRealm);
    if (setupFailure) console.log(`Direct-read prerequisite: ${setupFailure}`);
    if (closureFailure) console.log(`Direct-read closure prerequisite: ${closureFailure}`);
    if (privateClosureFailure) console.log(`Private teaser closure prerequisite: ${privateClosureFailure}`);
  } finally { finishRecording(); }
}, 300_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await closed?.close(); }
});

function paths(sessions: PersonaSessions, decision: string, person: PersonaSession) {
  return ['', '/works', '/decisions', `/decisions/${short(decision)}`, '/zone']
    .map(suffix => `${root(sessions)}${suffix}?${acting(person)}`);
}
async function reads(name: PersonaName) {
  expect(closureFailure, closureFailure ?? '').toBeNull();
  expect(privateClosureFailure, privateClosureFailure ?? '').toBeNull();
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = closed[name];
  const sample = recording.session(name, person);
  const recorded = async (label: string, path: string): Promise<Answer> => {
    const response = await sample(label, 'GET', path);
    return { status: response.status, body: await response.text() };
  };
  const failures: string[] = [];
  const closedPaths = paths(closed, adopted.decision!, person);
  const livePaths = paths(live, liveAdoption.decision!, person);
  const absentPaths = paths({ ...closed, realm: absentRealm }, adopted.decision!, person);
  for (let index = 0; index < closedPaths.length; index++) {
    const path = closedPaths[index]!;
    const control = before.get(`${name}:${path}`)!;
    const liveAnswer = await recorded(`live-${['realm-header', 'realm-works', 'realm-decisions', 'realm-decision', 'realm-zone'][index]}`, livePaths[index]!);
    if (control.status !== 200 || liveAnswer.status !== 200)
      failures.push(`Live control GET ${path}: before ${control.status} ${control.body}; independent ${liveAnswer.status} ${liveAnswer.body}`);
    const label = ['realm-header', 'realm-works', 'realm-decisions', 'realm-decision', 'realm-zone'][index]!;
    concealed(failures, path, await recorded(`closed-${label}`, path), await recorded(`absent-${label}`, absentPaths[index]!));
  }
  const joinPath = `${root(closed)}/join-page${person.actingSubject ? `?${acting(person)}` : ''}`;
  const absentJoin = `/v1/realms/${short(absentRealm)}/join-page${person.actingSubject ? `?${acting(person)}` : ''}`;
  const closedJoin = await recorded('closed-join-page', joinPath);
  const ordinaryJoin = await recorded('absent-join-page', absentJoin);
  expect(closedJoin.status).toBe(404);
  expect(ordinaryJoin.status).toBe(404);
  concealed(failures, joinPath, closedJoin, ordinaryJoin);
  const teaser = `${root(privateRealm)}/join-page?${acting(privateRealm[name])}`;
  const teaserBefore = before.get(`${name}:${teaser}`)!;
  // Joined readers get the home, so join-page intentionally refuses a teaser.
  const teaserStatus = ['member', 'owner', 'moderator'].includes(name) ? 404 : 200;
  if (teaserBefore.status !== teaserStatus)
    failures.push(`Live private teaser GET ${teaser}: ${teaserBefore.status} ${teaserBefore.body}`);
  concealed(failures, teaser, await observe(privateRealm[name], teaser),
    await observe(privateRealm[name], `/v1/realms/${short(absentRealm)}/join-page?${acting(privateRealm[name])}`));
  // A Realm adoption is not ancestry for this independent public publication.
  const independent = await recorded('independent-work', `/v1/works/${short(adopted.work)}?${acting(person)}`);
  if (independent.status !== 200)
    failures.push(`Independent GET /v1/works/${short(adopted.work)}: ${independent.status} ${independent.body}`);
  const publicationPath = `/v1/main-versions/${short(adopted.mainVersion)}/selection`;
  const publication = await recorded('independent-publication', publicationPath);
  if (publication.status !== 200 || (JSON.parse(publication.body) as { body?: string }).body !==
      'An original fixture story by the owner Person, published independently.')
    failures.push(`Independent publication GET ${publicationPath}: ${publication.status} ${publication.body}`);
  reportFailures(failures);
}
outcomeTest(declaration, 'visitor', () => closureCell(declaration, 'visitor', () => closed, () => qualify('visitor')), recording);
outcomeTest(declaration, 'stranger', () => closureCell(declaration, 'stranger', () => closed, () => qualify('stranger')), recording);
outcomeTest(declaration, 'member', () => closureCell(declaration, 'member', () => closed, () => qualify('member')), recording);
outcomeTest(declaration, 'owner', () => closureCell(declaration, 'owner', () => closed, () => qualify('owner')), recording);
outcomeTest(declaration, 'moderator', () => closureCell(declaration, 'moderator', () => closed, () => qualify('moderator')), recording);
outcomeTest(declaration, 'operator', () => closureCell(declaration, 'operator', () => closed, () => qualify('operator')), recording);

async function within<T>(milliseconds: number, part: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function qualify(name: PersonaName) {
  const started = performance.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The unchanged API proof owns its original 60 s, independently of the production visit.
    await within(60_000, 'API proof', () => reads(name));
    proofMs = performance.now() - started;
    visitStarted = performance.now();
    await within(120_000, 'production visit', () => productionVisit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || performance.now() - started} visitMs=${visitStarted ? performance.now() - visitStarted : 0}`);
  }
}

const requestLabels = new AsyncLocalStorage<(method: string, path: string) => string>();
async function productionVisit(name: PersonaName) {
  const original = globalThis.fetch;
  // Each persona starts with a cold production address cache, independent of earlier visits.
  const origin = `https://${name}.record.invalid`;
  const mainOrigin = `http://127.0.0.1:${Bun.env.MAIN_PORT}`;
  let person = closed[name];
  const publicSession: Pick<PersonaSession, 'main'> = {
    main: (method, path, body, key, options) => original(`${mainOrigin}${path}`, {
      method, headers: options?.headers, redirect: 'manual',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    }),
  };
  const publicRequest = recording.session(name, publicSession);
  const named = <T,>(label: string, run: () => Promise<T>) => requestLabels.run(() => label, run);
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) return original(input, init);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
    const label = requestLabels.getStore()?.(method, path);
    if (!label) throw new Error(`Production request has no label: ${method} ${path}`);
    const headers = new Headers(init?.headers);
    const personal = headers.has('authorization')
      || (url.pathname.startsWith('/api/main') && init?.credentials !== 'omit');
    headers.delete('authorization');
    const response = await (personal ? recording.session(name, person) : publicRequest)(label, method, path,
      typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      headers.get('idempotency-key') ?? undefined, { headers: Object.fromEntries(headers) });
    return response;
  };
  globalThis.fetch = Object.assign(transport, { preconnect: original.preconnect });
  const main = browserMainApi(origin, { fetcher: transport as typeof fetch });
  const anonymous = browserMainApi(origin, { anonymous: true, fetcher: transport as typeof fetch });
  try {
    async function entry(label: string, key: string, site = false): Promise<void> {
      // proxy admits each /r and /z request before the page renders. A closed
      // Space stops at its missing header; no works/decisions/Zone read follows.
      const address = await named(`${label}-address`, () => readAddress(
        { scope: 'space', key }, 'en', origin, new Headers()));
      if (address.kind !== 'missing' && address.kind !== 'resolved') return;
      let actingSubject: string | undefined;
      if (address.kind === 'missing' && person.actingSubject) {
        const session = await named(`${label}-session-agent`, () => main.v1.me['session-agent'].get());
        if (!session.error && session.data.sessionAgent.eligible)
          actingSubject = session.data.sessionAgent.actingSubject ?? undefined;
      }
      const page = await requestLabels.run((_method, path) => path.includes('/join-page')
        ? `${label}-join-page` : `${label}-header`, () => readSpacePage(key, 'en', {
        origin, incoming: new Headers(),
        ...(address.kind === 'resolved' ? { address: address.data } : {}),
        ...(person.actingSubject ? { token: 'persona-session', actingSubject } : {}),
      }));
      if (page.kind !== 'missing') throw new Error(`Closed production ${label} reached ${page.kind}`);
      if (address.kind !== 'resolved') return;
      if (address.data.state === 'redirect' && address.data.canonical.key !== key) {
        if (label.endsWith('-canonical')) throw new Error('Production address repeated its redirect');
        await entry(`${label}-canonical`, address.data.canonical.key, site);
        return;
      }
      if (!site) return;
      // A resolved Zone address passes admission even when its Realm landing is
      // missing. Site metadata and the page share these request-scoped reads.
      const publicFrame = realmFrameReads({ main: anonymous });
      let publication: ReturnType<typeof publicFrame.readCompletePresentation> | undefined;
      let session: ReturnType<typeof main.v1.me['session-agent']['get']> | undefined;
      const readSession = () => session ??= named(`${label}-frame-session-agent`, () =>
        main.v1.me['session-agent'].get());
      const frame = realmFrameReads({ main: anonymous, personal: person.actingSubject ? main : anonymous,
        actingSubject: person.actingSubject ?? undefined, resolution: {
          resolveAddress: async () => address,
          readCompletePresentation: zone => publication ??= requestLabels.run((_method, path) => {
            const after = new URL(path, origin).searchParams.get('after');
            return after ? `${label}-presentation-${after}` : `${label}-presentation`;
          }, () => publicFrame.readCompletePresentation(zone)),
          readRealmHeader: realm => named(`${label}-frame-header`, () => publicFrame.readRealmHeader(realm)),
          readPrivateRealm: async (ref, _locale, resolvedAddress) => {
            const state = person.actingSubject ? await readSession() : null;
            const subject = state && !state.error && state.data.sessionAgent.eligible
              ? state.data.sessionAgent.actingSubject ?? undefined : undefined;
            return requestLabels.run((_method, path) => path.includes('/join-page')
              ? `${label}-frame-join-page` : `${label}-frame-private-header`, () => readSpacePage(ref, 'en', {
              address: resolvedAddress, origin, incoming: new Headers(),
              ...(person.actingSubject ? { token: 'persona-session', actingSubject: subject } : {}),
            }));
          },
        } });
      const resolved = await frame.resolveSite(key, 'en');
      if (resolved.kind !== 'site') return;
      // siteContentMetadata reads the home route while the page resolves its
      // Realm frame. Both consume the same cached public presentation.
      await Promise.all([
        named(`${label}-frame-routes`, () => frame.readZoneRoute(resolved.zone, '/')),
        ...(resolved.realm ? [frame.resolveRealm(key, 'en', 'site'),
          ...(person.actingSubject ? [readSession()] : [])] : []),
      ]);
      if (!resolved.realm && person.actingSubject) {
        const state = await named(`${label}-site-session-agent`, () => main.v1.me['session-agent'].get());
        const subject = state.data?.sessionAgent.eligible ? state.data.sessionAgent.actingSubject : undefined;
        if (subject) {
          await requestLabels.run((_method, path) => {
            const after = new URL(path, origin).searchParams.get('after');
            return after ? `${label}-site-presentation-${after}` : `${label}-site-presentation`;
          }, () => realmFrameReads({ main: anonymous, personal: main, actingSubject: subject }).readCompletePresentation(resolved.zone));
          await named(`${label}-site-editor`, () => main.v1.zones({ id: resolved.zone })['showcase-editor'].get({ query: { actingSubject: subject } }));
        }
      }
    }
    await entry('home', short(closed.realm));
    await entry('adoptions', short(closed.realm));
    await entry('decisions', short(closed.realm));
    await entry('exact-decision', short(closed.realm));
    await entry('zone-entry', short(closed.zone), true);
    person = privateRealm[name];
    await entry('private-teaser', short(privateRealm.realm));
  } finally { globalThis.fetch = original; }
}
