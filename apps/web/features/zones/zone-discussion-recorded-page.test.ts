import { expect, test } from 'bun:test';
import type {
  AnswerPersona,
  AnswerRecord,
  AnswerSample,
} from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/zone/attached-realm-discussion.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { readAboutDiscussion } from './about-discussion-api.ts';
import {
  zoneDiscussionEntry,
  type ZoneDiscussionEntryInput,
} from './zone-discussion-recorded-page.ts';

const answers = record as AnswerRecord;
const actorIri = (path: string) =>
  new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = answers.personas[persona].find((answer) => answer.label === label);
  if (!found) throw new Error(`Missing recorded ${persona} answer: ${label}`);
  return found;
}

function replay(
  persona: AnswerPersona,
  selections: readonly { label: string; state: RecordedState }[],
) {
  const seen: string[] = [];
  const recorded = recordedFetch(answers, persona, selections, { pathPrefix: BFF_PREFIX });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    return recorded.fetcher(input, init);
  }) as typeof fetch;
  return { seen, main: browserMainApi('https://recorded.invalid', { anonymous: true, fetcher }) };
}

function recordedName(
  value: unknown,
): NonNullable<Extract<ZoneDiscussionEntryInput['header'], { ok: true }>['name']> {
  if (!value || typeof value !== 'object') throw new Error('Recorded realm name missing');
  const name = value as { value?: unknown; language?: unknown; direction?: unknown };
  if (
    typeof name.value !== 'string' ||
    typeof name.language !== 'string' ||
    (name.direction !== 'ltr' && name.direction !== 'rtl')
  )
    throw new Error('Recorded realm name is incomplete');
  return { value: name.value, language: name.language, direction: name.direction };
}

test('the recorded attached discussion names its thread, and a missing body stays concealed', async () => {
  const canonical = sample('stranger', 'canonical-about-thread');
  const route = sample('stranger', 'current-discussion-route');
  const targetSample = sample('stranger', 'current-discussion-target');
  const headerSample = sample('stranger', 'realm-policy');
  const transport = replay('stranger', [
    { label: 'current-discussion-route', state: 'populated' },
    { label: 'current-discussion-target', state: 'populated' },
    { label: 'canonical-about-thread', state: 'populated' },
    { label: 'realm-policy', state: 'populated' },
    { label: 'joining-context', state: 'populated' },
  ]);
  const lookupUrl = new URL(canonical.path, 'https://recorded.invalid');
  const actor = actorIri(canonical.path);
  if (!actor) throw new Error('Recorded discussion has no actor');
  const lookup = await transport.main.v1
    .realms({ realm: lookupUrl.pathname.split('/')[3]! })
    ['about-thread'].get({
      query: { about: lookupUrl.searchParams.get('about')!, actingSubject: actor },
    });
  expect(lookup.data).toEqual(canonical.answer);
  const pointer = lookup.data?.thread;
  if (!pointer) throw new Error('Recorded discussion has no thread');
  const routeAnswer = route.answer as {
    realm: string;
    zone: string;
    path: string;
    revision: string;
    resource: { id: string };
  };
  const target = (targetSample.answer as { target: { resource: string; revision: string } }).target;
  const header = headerSample.answer as { name: unknown; reviewMode: string };
  expect(pointer.rootRevision).toBe(target.revision);
  expect(target.resource).toBe(routeAnswer.resource.id);
  const read = await readAboutDiscussion(transport.main, {
    zone: routeAnswer.zone,
    path: new URL(route.path, 'https://recorded.invalid').searchParams.get('path')!,
    signedIn: true,
    actingSubject: actor,
    personal: true,
  });
  expect(read).toEqual({ kind: 'unavailable' });
  const threadPath = `/v1/realms/${lookupUrl.pathname.split('/')[3]}/threads/${pointer.reply.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`;
  expect(transport.seen).toContain(`GET ${BFF_PREFIX}${route.path}`);
  expect(transport.seen).toContain(`GET ${BFF_PREFIX}${canonical.path}`);
  expect(transport.seen).toContain(`GET ${BFF_PREFIX}${targetSample.path}`);
  expect(transport.seen).toContain(`GET ${BFF_PREFIX}${headerSample.path}`);
  expect(transport.seen).toContain(
    `GET ${BFF_PREFIX}${sample('stranger', 'joining-context').path}`,
  );
  expect(transport.seen).toContain(`GET ${BFF_PREFIX}${threadPath}`);
  expect(
    zoneDiscussionEntry({
      route: routeAnswer,
      about: routeAnswer.resource.id,
      target,
      lookup: { ok: true, thread: pointer },
      header: { ok: true, name: recordedName(header.name), reviewMode: header.reviewMode },
      joining: {
        ok: true,
        state: (sample('stranger', 'joining-context').answer as { state: string }).state,
      },
      thread: { ok: false },
      signedIn: true,
      actingSubject: actor,
      personal: true,
    }),
  ).toEqual({ kind: 'unavailable' });
});

test('a recorded forbidden about-thread is work_unavailable and exposes no discussion', async () => {
  const refused = sample('visitor', 'private-about-thread');
  const transport = replay('visitor', [{ label: 'private-about-thread', state: 'error' }]);
  const url = new URL(refused.path, 'https://recorded.invalid');
  const lookup = await transport.main.v1
    .realms({ realm: url.pathname.split('/')[3]! })
    ['about-thread'].get({
      query: { about: url.searchParams.get('about')! },
    });
  expect(lookup.data).toBeNull();
  expect(lookup.error?.status).toBe(refused.status);
  expect(lookup.error?.value).toEqual(refused.answer);
  const route = sample('stranger', 'current-discussion-route').answer as {
    realm: string;
    zone: string;
    path: string;
    revision: string;
    resource: { id: string };
  };
  const target = (
    sample('stranger', 'current-discussion-target').answer as {
      target: { resource: string; revision: string };
    }
  ).target;
  const header = sample('stranger', 'realm-policy').answer as { name: unknown; reviewMode: string };
  // The private zone route is not recorded. The refused lookup still cannot become the published page's thread.
  expect(
    zoneDiscussionEntry({
      route,
      about: route.resource.id,
      target,
      lookup: { ok: false },
      header: { ok: true, name: recordedName(header.name), reviewMode: header.reviewMode },
      joining: null,
      thread: null,
      signedIn: false,
      personal: false,
    }),
  ).toEqual({ kind: 'unavailable' });
});

test('a recorded empty about-thread stays empty for the same published page', async () => {
  const empty = sample('visitor', 'empty-about-thread');
  const transport = replay('visitor', [{ label: 'empty-about-thread', state: 'empty' }]);
  const url = new URL(empty.path, 'https://recorded.invalid');
  const lookup = await transport.main.v1
    .realms({ realm: url.pathname.split('/')[3]! })
    ['about-thread'].get({
      query: { about: url.searchParams.get('about')! },
    });
  expect(lookup.data).toEqual(empty.answer);
  expect(lookup.data?.thread).toBeNull();
  const route = sample('stranger', 'current-discussion-route').answer as {
    realm: string;
    zone: string;
    path: string;
    revision: string;
    resource: { id: string };
  };
  const target = (
    sample('stranger', 'current-discussion-target').answer as {
      target: { resource: string; revision: string };
    }
  ).target;
  const header = sample('stranger', 'realm-policy').answer as { name: unknown; reviewMode: string };
  const about = (empty.answer as { about: string }).about;
  expect(about).toBe(route.resource.id);
  expect(target.resource).toBe(about);
  const name = recordedName(header.name);
  expect(
    zoneDiscussionEntry({
      route,
      about,
      target,
      lookup: { ok: true, thread: null },
      header: { ok: true, name, reviewMode: header.reviewMode },
      joining: null,
      thread: null,
      signedIn: false,
      personal: false,
    }),
  ).toEqual({
    kind: 'ready',
    basis: {
      realm: route.realm,
      about,
      targetRevision: target.revision,
      zone: `https://rezics.com/id/${route.zone.slice(-36)}`,
      path: route.path,
      routeRevision: route.revision,
    },
    thread: null,
    mode: 'sign-in',
    realmName: name,
    actingSubject: null,
  });
});
