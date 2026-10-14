import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordedMainClient } from '../../../support/recorded-main-client.ts';
import { readRankingAnswer, readRankingModuleAnswer } from '../../../../../apps/web/features/realm/ranking-read.ts';
import { closureSetup, closureCell, effectClosure, publishClosureRule } from './closure-fixture.ts';
import closure from '../../../../../scripts/qa/cases/outcomes/realm/closure-rankings.ts';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClosureCreditEvidence, publishClosureOriginals, type ClosureOriginal } from './closure-original-credit-setup.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
type Publication = ClosureOriginal;
let sessions: PersonaSessions;
const publications: Publication[] = [];
let closureUnavailable: string | null = null;
let journeyStarted = 0;
let evidence: ReturnType<typeof createClosureCreditEvidence>;
const recording = new OutcomeRecorder(closure);
const phrase = `Closuregarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function missing(person: PersonaSession, path: string, absent: string) {
  const unavailable = await person.main('GET', path);
  const ordinary = await person.main('GET', absent);
  expect(ordinary.status, absent).toBe(404);
  expect(unavailable.status, path).toBe(ordinary.status);
  expect(await unavailable.json(), path).toEqual(await ordinary.json());
}

async function requireClosure(person: PersonaSession) {
  // A refused prerequisite is not an observed delivery defect. Each person
  // confirms the still-open public Realm through their own HTTP session.
  if (closureUnavailable) {
    await answer(person.main('GET', `/v1/realms/${short(sessions.realm)}?${acting(person)}`));
    throw new Error(closureUnavailable);
  }
}

async function independent(person: PersonaSession) {
  for (const publication of publications) {
    await answer(person.main('GET', `/v1/works/${short(publication.work)}`));
    const credits = await answer<{ items: { agent: string; role: string }[] }>(
      person.main('GET', `/v1/works/${short(publication.work)}/agent-credits`),
    );
    expect(credits.items).toContainEqual(
      expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }),
    );
  }
}


async function prepareSurface() {
  const baseline = await answer<{ items: { id: string }[] }>(
    sessions.visitor.main('GET', `/v1/realms/${short(sessions.realm)}/modules/new-adoptions`),
  );
  expect(baseline.items.map(item => item.id).sort()).toEqual(publications.map(item => item.work).sort());
  await independent(sessions.visitor);
}
async function delivered(name: PersonaName) {
  const person = sessions[name];
  await requireClosure(person);
  const root = `/v1/realms/${short(sessions.realm)}`;
  const absent = `/v1/realms/${randomUUID()}`;
  for (const [sort, window] of [['best', 'all'], ['top', 'week'], ['top', 'month'], ['top', 'all']] as const) {
    const missing = await readRankingAnswer(recordedMainClient(recording, name, person, `${sort}-${window}-missing`), {
      realm: sessions.realm, sort, window, actingSubject: person.actingSubject,
    });
    expect(missing).toMatchObject({ ok: false, status: 404, failure: 'missing' });
  }
  for (const interval of ['day', 'week', 'month'] as const) {
    const missing = await readRankingModuleAnswer(recordedMainClient(recording, name, person,
      `ranking-module-${interval}-missing`), sessions.realm, interval, 'reads');
    expect(missing).toMatchObject({ ok: false, failure: 'missing' });
  }
  for (const suffix of ['/threads?sort=best&window=all', '/threads?sort=top&window=all',
    '/rankings', '/modules/rising']) {
    const query = person.actingSubject && suffix.startsWith('/threads') ? `&${acting(person)}` : '';
    await missing(person, `${root}${suffix}${query}`, `${absent}${suffix}${query}`);
  }
  for (const path of ['/v1/rankings/trending', '/v1/trending?scope=global']) {
    const page = await answer<unknown>(person.main('GET', path));
    const bytes = JSON.stringify(page);
    expect(bytes).not.toContain(sessions.realm);
    for (const publication of publications) expect(bytes).not.toContain(publication.selection);
  }
  const scoped = `/v1/trending?scope=${encodeURIComponent(`realm:${sessions.realm}`)}`;
  const missingScope = `/v1/trending?scope=${encodeURIComponent(`realm:https://rezics.com/id/${randomUUID()}`)}`;
  const query = person.actingSubject ? `&${acting(person)}` : '';
  await missing(person, scoped + query, missingScope + query);
  await independent(person);
}

describe('rankings closure journey', () => {
  beforeAll(async () => {
    const started = performance.now();
    evidence = createClosureCreditEvidence('realm/closure-rankings', 'journey', import.meta.path);
    sessions = await evidence.phase('persona-preparation', () => personaSessions('public'));
    await recording.prepare();
    evidence.observe(sessions);
    closureUnavailable = await closureSetup(sessions, () => evidence.phase('preparation', async () => {
      const rule = await evidence.phase('closure-rule', () => publishClosureRule(sessions));
      await evidence.phase('original-publication', () => publishClosureOriginals(sessions, publications, phrase));
      await evidence.phase('surface-preparation', prepareSurface);
      await evidence.phase('effect-closure', () => effectClosure(sessions, rule));
    }));
    evidence.record({ kind: 'preparation-result', row: closure.rowId,
      personaSeconds: sessions.elapsedSeconds, preparationSeconds: (performance.now() - started) / 1000,
      source: import.meta.path, failure: closureUnavailable });
    journeyStarted = performance.now();
  }, 180_000);

  afterAll(async () => {
    try {
      evidence?.record({ kind: 'journey-timing', row: closure.rowId,
        journeySeconds: journeyStarted ? (performance.now() - journeyStarted) / 1000 : null });
      await recording.publish();
    } finally {
      await sessions?.close();
    }
  });

  outcomeTest(closure, 'visitor', () => evidence.phase('journey-visitor', () => closureCell(closure, 'visitor', () => sessions, () => delivered('visitor'))), recording);
  outcomeTest(closure, 'stranger', () => evidence.phase('journey-stranger', () => closureCell(closure, 'stranger', () => sessions, () => delivered('stranger'))), recording);
  outcomeTest(closure, 'member', () => evidence.phase('journey-member', () => closureCell(closure, 'member', () => sessions, () => delivered('member'))), recording);
  outcomeTest(closure, 'owner', () => evidence.phase('journey-owner', () => closureCell(closure, 'owner', () => sessions, () => delivered('owner'))), recording);
  outcomeTest(closure, 'moderator', () => evidence.phase('journey-moderator', () => closureCell(closure, 'moderator', () => sessions, () => delivered('moderator'))), recording);
  outcomeTest(closure, 'operator', () => evidence.phase('journey-operator', () => closureCell(closure, 'operator', () => sessions, () => delivered('operator'))), recording);

});
