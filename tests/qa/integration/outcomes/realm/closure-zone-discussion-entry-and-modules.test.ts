import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { mainApiWithToken } from '../../../../../apps/web/features/api/main.ts';
import { readAboutDiscussion } from '../../../../../apps/web/features/zones/about-discussion-api.ts';
import { closureSetup, closureCell, effectClosure, publishClosureRule } from './closure-fixture.ts';
import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-zone-discussion-entry-and-modules.ts';
import { publishClosureOriginals } from './closure-original-credit-setup.ts';
import { closureZoneReadPath, prepareClosureZoneHome } from './closure-zone-home-setup.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Work = { work: string; mainVersion: string; workRevision: string };
type Publication = Work & { contribution: string; publicationDecision: string; selection: string };
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(closure);
const publications: Publication[] = [];
let closureUnavailable: string | null = null;
const phrase = `Closuregarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function missing(person: PersonaSession, path: string, absent: string) {
  const unavailable = await person.main('GET', closureZoneReadPath(path, person));
  const ordinary = await person.main('GET', closureZoneReadPath(absent, person));
  expect(ordinary.status, absent).toBe(404);
  expect(unavailable.status, path).toBe(ordinary.status);
  expect(await unavailable.json(), path).toEqual(await ordinary.json());
}

async function requireClosure(person: PersonaSession) {
  // A refused prerequisite is not an observed delivery defect. Each person
  // confirms the still-open public Realm through their own HTTP session.
  if (closureUnavailable) {
    await answer(person.main('GET', closureZoneReadPath(`/v1/realms/${short(sessions.realm)}`, person)));
    throw new Error(closureUnavailable);
  }
}

async function independent(person: PersonaSession) {
  for (const publication of publications) {
    await answer(person.main('GET', closureZoneReadPath(`/v1/works/${short(publication.work)}`, person)));
    const credits = await answer<{ items: { agent: string; role: string }[] }>(
      person.main('GET', closureZoneReadPath(`/v1/works/${short(publication.work)}/agent-credits`, person)),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }),
    );
  }
}

async function publishOriginals() {
  await publishClosureOriginals(sessions, publications, phrase);
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  closureUnavailable = await closureSetup(sessions, async () => {
    const rule = await publishClosureRule(sessions);
    await publishOriginals();
    await prepareSurface();
    await effectClosure(sessions, rule);
  });
}, 180_000);

afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

let homeRevision: string;
async function prepareSurface() {
  const home = await prepareClosureZoneHome(sessions, publications[0]!);
  homeRevision = home.draft.revisionId;
  const root = `/v1/zones/${short(sessions.zone)}`;
  const baseline = await answer<{ realm: string | null; moduleData: { sources: { state: string }[] }[] }>(
    sessions.visitor.main('GET', `${root}/presentation`),
  );
  expect(baseline.realm).toBe(sessions.realm);
  expect(baseline.moduleData[0]!.sources[0]!.state).toBe('public-read');
  await independent(sessions.visitor);
}

async function delivered(name: PersonaName) {
  const source = sessions[name], sample = recording.session(name, source);
  let ordinal = 0;
  const person: PersonaSession = { ...source, main: (...args) => {
    const path = new URL(args[1], 'https://record.invalid');
    const label = path.pathname.endsWith('/routes') ? path.searchParams.get('path') === '/'
      ? 'closed-zone-home-route' : 'closed-zone-original-route'
      : path.pathname.endsWith('/presentation') ? 'closed-zone-presentation'
      : path.pathname.includes('/modules/') ? `${path.pathname.includes(short(sessions.realm)) ? 'closed' : 'absent'}-module-${path.pathname.split('/').at(-1)}`
      : `closed-zone-proof-${++ordinal}`;
    return sample(label, ...args);
  } };
  await requireClosure(person);
  const root = `/v1/realms/${short(sessions.realm)}`;
  const absent = `/v1/realms/${randomUUID()}`;
  for (const suffix of [
    '/zone', `/about-thread?about=${encodeURIComponent(publications[0]!.work)}`,
    ...['new-adoptions', 'recently-completed', 'recent-decisions', 'latest-chapters',
      'discussions', 'reader-quotes', 'editor-lists', 'browse'].map(module => `/modules/${module}`),
  ]) await missing(person, `${root}${suffix}`, `${absent}${suffix}`);
  const zone = `/v1/zones/${short(sessions.zone)}`;
  const route = await answer<{ realm: string | null; page: unknown }>(person.main('GET', closureZoneReadPath(`${zone}/routes?path=/`, person)));
  expect(route.realm).toBeNull();
  expect(JSON.stringify(route.page)).toContain('Independent original Zone home document');
  const presentation = await answer<{ realm: string | null; moduleData: { id: string; sources: { state: string }[] }[] }>(
    person.main('GET', closureZoneReadPath(`${zone}/presentation`, person)),
  );
  expect(presentation.realm).toBeNull();
  expect(presentation.moduleData.find(module => module.id === 'latest')!.sources[0]!.state).toBe('unavailable');
  const mounted = await answer<{ resource: { id: string } }>(person.main('GET', closureZoneReadPath(`${zone}/routes?path=/original`, person)));
  expect(mounted.resource.id).toBe(publications[0]!.work);
  const home = await answer<unknown>(person.main('GET', closureZoneReadPath(`/v1/content-revisions/${homeRevision}`, person)));
  expect(JSON.stringify(home)).toContain('Independent original Zone home document');
  await independent(person);
  for (const path of ['/', '/original']) {
    const requested: string[] = [];
    const fetcher = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requested.push(url.pathname);
      return sample(`closed-discussion-${path === '/' ? 'home' : 'original'}-route`,
        init?.method ?? 'GET', `${url.pathname}${url.search}`);
    }) as typeof fetch;
    const entry = await readAboutDiscussion(mainApiWithToken(source.actingSubject ? 'recorded-session' : undefined,
      { fetcher }), { zone: sessions.zone, path, signedIn: Boolean(source.actingSubject),
      actingSubject: source.actingSubject ?? undefined, personal: Boolean(source.actingSubject) });
    expect(entry).toEqual({ kind: 'none' });
    expect(requested).toEqual([`${zone}/routes`]);
  }
}

outcomeTest(closure, 'visitor', () => closureCell(closure, 'visitor', () => sessions, () => delivered('visitor')), recording);
outcomeTest(closure, 'stranger', () => closureCell(closure, 'stranger', () => sessions, () => delivered('stranger')), recording);
outcomeTest(closure, 'member', () => closureCell(closure, 'member', () => sessions, () => delivered('member')), recording);
outcomeTest(closure, 'owner', () => closureCell(closure, 'owner', () => sessions, () => delivered('owner')), recording);
outcomeTest(closure, 'moderator', () => closureCell(closure, 'moderator', () => sessions, () => delivered('moderator')), recording);
outcomeTest(closure, 'operator', () => closureCell(closure, 'operator', () => sessions, () => delivered('operator')), recording);

