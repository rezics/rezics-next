import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fromPlainText } from '@rezics/document';
import {
  personaNames, personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../support/personas.ts';

type Answer = { status: number; body: string };
type Site = { space: string; zone: string; zoneRevision: string; navigationRevision: string };
type Configuration = { zone: string; revision: string;
  configuration: { defaultRealm?: string; homeDocument?: string } };
type Draft = { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
type Publication = { outcome: string; zone: string; revision: string; themeRevision: string;
  receipt: string; homeDocument: string; homeRevision: string; replayed: boolean;
  pages: { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }[] };
type Phase = 'saved-unpublished' | 'published-original' | 'saved-replacement' | 'published-replacement';
type Reads = { original: Answer; replacement: Answer; absent: Answer; presentation: Answer };
const answers = new Map<Phase, Map<PersonaName, Reads>>();
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
const absent = `https://rezics.com/id/${randomUUID()}`;
const homeDocument = fromPlainText('A published home for independent Realm entry selection.', 'blocks');
const identifiers = new Set<string>([absent]);
let sessions: PersonaSessions;
let site: Site;
let replacement: { realm: string; space: string };
let first: Publication;
let second: Publication;
let draft: Draft;
let saved: Configuration;
let changed: Configuration;
let phase: string = 'personas';
let prerequisite: string | null = null;
let setupStarted: number;
const runId = Bun.env.REZICS_QA_RUN_ID ?? randomUUID();
const evidence = `.temp/goal/${runId}-realm-zone-public-attachment.jsonl`;

function record(value: object) {
  mkdirSync('.temp/goal', { recursive: true });
  appendFileSync(evidence, `${JSON.stringify({ runId, phase, ...value })}\n`);
}
function retainIds(value: unknown) {
  for (const match of JSON.stringify(value).matchAll(/https:\/\/rezics\.com\/id\/[0-9a-f-]{36}|urn:rezics:[^"\s]+/g))
    identifiers.add(match[0]);
}

async function exchange(person: PersonaSession, method: string, path: string, body?: unknown): Promise<Answer> {
  const key = method === 'GET' ? undefined : randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const request = { method, path, body: body ?? null, key: key ?? null };
  const caller = { account: person.accountId, subject: person.actingSubject };
  record({ event: 'request-start', caller, request, startedAt });
  const response = await person.main(method, path, body, key, { settle: false });
  const answer = { status: response.status, body: await response.text() };
  record({ event: 'request-end', caller, request, answer, startedAt,
    endedAt: new Date().toISOString(), durationMs: performance.now() - started });
  return answer;
}
async function command<T>(person: PersonaSession, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const answer = await exchange(person, method, path, body);
  if (answer.status !== status) {
    record({ event: 'prerequisite-refused', request: { method, path, body: body ?? null }, answer });
    throw new Error(`${phase}: ${method} ${path}: expected ${status}, received ${answer.status} ${answer.body}`);
  }
  const value = JSON.parse(answer.body) as T;
  retainIds(value);
  return value;
}
const config = () => command<Configuration>(sessions.owner, 'GET',
  `/v1/zones/${short(site.zone)}/configuration${acting(sessions.owner)}`);

async function createReplacement() {
  const owner = sessions.owner;
  const created = await command<{ realm: string; space: string }>(owner, 'POST', '/v1/spaces', {
    profile: 'space-realm-v2', name: 'Public attachment replacement Realm',
    handle: `entry-${randomUUID().slice(0, 12)}`, language: 'en', capabilities: ['realm'],
    actingSubject: owner.actingSubject,
    initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
      whoMaySubmit: 'members', selfJoin: true, rules: [] },
  }, 201);
  const root = `/v1/realms/${short(created.realm)}`;
  await command(owner, 'POST', `${root}/management`, { actingSubject: owner.actingSubject });
  for (const person of [sessions.member, sessions.moderator]) {
    const policy = await command<{ membershipGeneration: string; policyRevision: string; termsRevision: string }>(
      person, 'GET', `${root}/joining${acting(person)}`);
    await command(person, 'POST', `${root}/join`, {
      actingSubject: person.actingSubject, expectedMembershipGeneration: policy.membershipGeneration,
      expectedPolicyRevision: policy.policyRevision, termsRevision: policy.termsRevision, listed: false,
    });
  }
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Entry control moderators', permissions: ['governance.moderate'] },
    { kind: 'assignment', roleId, member: sessions.moderator.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const basis = await command<{ generation: string }>(owner, 'GET', `${root}/roles${acting(owner)}`);
    const input = { actingSubject: owner.actingSubject, expectedGeneration: basis.generation,
      reason: 'Keep the six reader roles consistent across the entry controls', change };
    const impact = await command<{ digest: string }>(owner, 'POST', `${root}/role-impact`, input);
    await command(owner, 'POST', `${root}/role-changes`, { ...input, impactDigest: impact.digest }, 201);
  }
  return { realm: created.realm, space: created.space };
}

async function observe(state: Phase) {
  phase = state;
  const readers = new Map<PersonaName, Reads>();
  answers.set(state, readers);
  for (const name of personaNames) {
    const person = sessions[name];
    const entry = (realm: string) => exchange(person, 'GET', `/v1/realms/${short(realm)}/zone${acting(person)}`);
    readers.set(name, {
      original: await entry(sessions.realm), replacement: await entry(replacement.realm),
      // Actual absence is observed independently; it does not define no-entry semantics.
      absent: await entry(absent),
      presentation: await exchange(person, 'GET', `/v1/zones/${short(site.zone)}/presentation${acting(person)}`),
    });
  }
}

async function publish(configuration: Configuration) {
  const owner = sessions.owner;
  const navigation = await command<{ revision: string }>(owner, 'GET',
    `/v1/zones/${short(site.zone)}${acting(owner)}`);
  const publication = await command<Publication>(owner, 'POST', `/v1/zones/${short(site.zone)}/site-publications`, {
    expectedHead: configuration.revision, actingSubject: owner.actingSubject,
    routesRevision: navigation.revision, navigationRevision: navigation.revision,
    pages: [{ page: configuration.configuration.homeDocument, variantId,
      revisionId: draft.revisionId, byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }, 201);
  expect(publication).toMatchObject({ outcome: 'succeeded', zone: site.zone,
    themeRevision: configuration.revision, homeDocument: configuration.configuration.homeDocument,
    replayed: false });
  expect(publication.homeRevision).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(publication.pages).toHaveLength(1);
  expect(publication.pages[0]).toMatchObject({ page: configuration.configuration.homeDocument,
    variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch });
  expect(publication.receipt).toBeTruthy();
  expect(publication.revision).not.toBe(configuration.revision);
  const head = await config();
  expect(head.revision).toBe(publication.revision);
  expect(head.configuration).toEqual(configuration.configuration);
  record({ event: 'selected-publication', sourceRevision: configuration.revision,
    servedRevision: publication.revision, publication, head });
  return publication;
}
const variantId = `urn:rezics:variant:${randomUUID()}`;

beforeAll(async () => {
  setupStarted = performance.now();
  record({ event: 'preparation-start', at: new Date().toISOString(), evidence });
  try {
    sessions = await personaSessions('public', { observeMain: async observation => {
      record({ event: 'persona-request', caller: {
        account: observation.caller.accountId, subject: observation.caller.actingSubject,
      }, request: observation.request, answer: observation.response,
      startedAt: new Date(observation.requestStartedAt).toISOString(),
      endedAt: new Date(observation.answeredAt).toISOString(),
      durationMs: observation.answeredAt - observation.requestStartedAt });
      if (phase === 'personas') {
        const body = observation.request.body as { profile?: string } | null;
        if (observation.request.method === 'POST' && observation.request.path === '/v1/spaces'
          && body?.profile === 'space-zone-v1' && observation.response.status === 201) {
          site = JSON.parse(observation.response.body) as Site;
          retainIds(site);
        }
        // A refused setup command stops before the shared helper can settle or repeat it.
        if (observation.response.status >= 400 || observation.response.status === 202) {
          record({ event: 'prerequisite-refused', request: observation.request, answer: observation.response });
          throw new Error(`personas: ${observation.request.method} ${observation.request.path}: `
            + `${observation.response.status} ${observation.response.body}`);
        }
      }
    } });
    phase = 'independent-spaces';
    expect(site.zone).toBe(sessions.zone);
    expect(site.space).not.toBe(sessions.space);
    retainIds({ realm: sessions.realm, space: sessions.space });
    for (const expected of [
      { space: sessions.space, realm: sessions.realm, capabilities: ['realm'] },
      { space: site.space, zone: site.zone, capabilities: ['zone'] },
    ]) {
      const read = await command(sessions.owner, 'GET', `/v1/spaces/${short(expected.space)}`);
      expect(read).toMatchObject({ ...expected, owner: sessions.owner.actingSubject, state: 'active' });
    }
    replacement = await createReplacement();
    expect(replacement.space).not.toBe(site.space);
    expect(replacement.space).not.toBe(sessions.space);
    expect(await command(sessions.owner, 'GET', `/v1/spaces/${short(replacement.space)}`))
      .toMatchObject({ ...replacement, owner: sessions.owner.actingSubject, capabilities: ['realm'], state: 'active' });
    saved = await config();
    expect(saved.configuration.defaultRealm).toBe(sessions.realm);
    expect(saved.revision).not.toBe(site.zoneRevision);
    record({ event: 'creation-and-saved', creation: site, saved });
    await observe('saved-unpublished');

    phase = 'prepare-first-publication';
    await command(sessions.owner, 'PUT', `/v1/zones/${short(site.zone)}/configuration`, {
      actingSubject: sessions.owner.actingSubject, expectedHead: saved.revision, prepareHomeDocument: true,
    });
    const prepared = await config();
    expect(prepared.configuration.defaultRealm).toBe(sessions.realm);
    expect(prepared.configuration.homeDocument).toBeTruthy();
    draft = await command<Draft>(sessions.owner, 'POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: prepared.configuration.homeDocument, variantId,
      expectedHead: null, document: homeDocument,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      actingSubject: sessions.owner.actingSubject,
    }, 201);
    identifiers.add(draft.revisionId);
    identifiers.add(variantId);
    first = await publish(prepared);
    await observe('published-original');

    phase = 'save-replacement';
    const head = await config();
    expect(head.revision).toBe(first.revision);
    await command(sessions.owner, 'PUT', `/v1/zones/${short(site.zone)}/configuration`, {
      actingSubject: sessions.owner.actingSubject, expectedHead: head.revision, defaultRealm: replacement.realm,
    });
    changed = await config();
    expect(changed.configuration.defaultRealm).toBe(replacement.realm);
    expect(changed.revision).not.toBe(first.revision);
    record({ event: 'saved-after-publication', saved: changed, selected: first });
    await observe('saved-replacement');

    phase = 'publish-replacement';
    second = await publish(changed);
    expect(second.revision).not.toBe(first.revision);
    await observe('published-replacement');
  } catch (error) {
    prerequisite = String(error);
    record({ event: 'setup-failed', error: prerequisite });
    console.error('Realm entry setup failed', prerequisite);
  } finally {
    const durationMs = performance.now() - setupStarted;
    record({ event: 'preparation-end', at: new Date().toISOString(), durationMs });
    console.log('Realm entry evidence', JSON.stringify({ runId, evidence, durationMs, prerequisite }));
  }
}, 300_000);
afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) {
  test(`${name}: Realm entry consumes only the explicitly published Zone attachment`, () => {
    expect(prerequisite, prerequisite ?? '').toBeNull();
    const failures: string[] = [];
    const check = (label: string, fn: () => void) => {
      try { fn(); } catch (error) { failures.push(`${label}: ${String(error)}`); }
    };
    const initial = answers.get('saved-unpublished')!.get(name)!;
    const noEntry = (label: string, answer: Answer) => {
      check(`${label}: exact status/code`, () => {
        expect(answer.status, answer.body).toBe(404);
        expect(JSON.parse(answer.body).code).toBe('realm_unavailable');
        expect(answer.status).not.toBe(503);
      });
      check(`${label}: complete no-entry answer`, () => { expect(answer).toEqual(initial.replacement); });
      check(`${label}: no disclosed identifiers`, () => {
        for (const id of identifiers) {
          expect(answer.body).not.toContain(id);
          expect(answer.body).not.toContain(short(id));
        }
      });
    };
    const live = (label: string, answer: Answer, realm: string, publication: Publication) => check(label, () => {
      expect(answer.status, answer.body).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({ profile: 'realm-zone-v1', realm, zone: site.zone,
        revision: publication.revision, presentationUrl: `/v1/zones/${short(site.zone)}/presentation` });
    });
    noEntry('Realm without an entry', initial.replacement);
    noEntry('saved unpublished attachment', initial.original);
    for (const state of ['saved-unpublished', 'published-original', 'saved-replacement', 'published-replacement'] as const) {
      const read = answers.get(state)!.get(name)!;
      check(`${state}: actual absent resource`, () => {
        expect(read.absent.status, read.absent.body).toBe(404);
        expect(JSON.parse(read.absent.body).code).toBe('realm_unavailable');
        expect(read.absent).toEqual(initial.absent);
      });
      check(`${state}: Zone selected revision`, () => {
        expect(read.presentation.status, read.presentation.body).toBe(200);
        expect(JSON.parse(read.presentation.body)).toMatchObject({ zone: site.zone,
          realm: state === 'saved-unpublished' ? null
            : state === 'published-replacement' ? replacement.realm : sessions.realm,
          revision: state === 'saved-unpublished' ? site.zoneRevision
            : state === 'published-replacement' ? second.revision : first.revision });
      });
      check(`${state}: published home selection`, () => {
        const presentation = JSON.parse(read.presentation.body) as {
          home?: { reference: object; document: object };
        };
        if (state === 'saved-unpublished') expect(presentation.home).toBeUndefined();
        else {
          expect(presentation.home?.reference).toMatchObject({ resourceId: first.homeDocument,
            variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest });
          expect(presentation.home?.document).toEqual(homeDocument);
        }
      });
      if (state === 'published-original' || state === 'saved-replacement') {
        live(`${state}: original selected entry`, read.original, sessions.realm, first);
        noEntry(`${state}: replacement has no public entry`, read.replacement);
      } else if (state === 'published-replacement') {
        live(`${state}: replacement selected entry`, read.replacement, replacement.realm, second);
        noEntry(`${state}: original has no public entry`, read.original);
      }
      record({ event: 'reader-matrix', persona: name, state, caller: {
        account: sessions[name].accountId, subject: sessions[name].actingSubject,
      }, read });
    }
    record({ event: 'reader-result', persona: name, failures });
    if (failures.length) console.error(`${name}: ${failures.join('\n')}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });
}
