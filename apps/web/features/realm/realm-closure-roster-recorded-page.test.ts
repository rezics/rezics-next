import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/realm/closure-roster.json';
import { BFF_PREFIX } from '../api/browser.ts';
import { resourceHref } from '../address/path.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { RealmHeader, RealmRoster } from './types.ts';
import { RealmAbout } from './views.tsx';
import { RealmNotFound } from './states.tsx';
import { messages } from './messages.ts';

const { closureRosterClient, closureRosterRoute, rosterSample } = await import('./realm-closure-roster-recorded-page.tsx');
const record = fixture as AnswerRecord;
const personas = Object.keys(record.personas) as AnswerPersona[];
const sample = (persona: AnswerPersona, label: string) => rosterSample(record, persona, label);

function about(node: ReactNode): React.ComponentProps<typeof RealmAbout> | null {
  if (Array.isArray(node)) return node.map(about).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === RealmAbout) return node.props as React.ComponentProps<typeof RealmAbout>;
  return about(node.props.children);
}

async function visit(persona: AnswerPersona, live: boolean, cursor?: string) {
  const samples = record.personas[persona].filter(item => item.label.startsWith(live ? 'live-page-' : 'members-'));
  const replay = recordedFetch(record, persona, samples.map(item => ({ label: item.label,
    state: item.status >= 400 ? 'error' : 'populated' })), { pathPrefix: BFF_PREFIX });
  const requests: { url: string; credentials: RequestCredentials | undefined }[] = [];
  let missed: unknown;
  const fetcher = (async (input, init) => {
    requests.push({ url: new Request(input, init).url, credentials: init?.credentials });
    try { return await replay.fetcher(input, init); }
    catch (error) { missed = error; throw error; }
  }) as typeof fetch;
  try {
    const ref = new URL(sample(persona, live ? 'live-page-address' : 'members-address').path, 'https://recorded.invalid').searchParams.get('key')!;
    const actor = new URL(sample(persona, 'members-private-header').path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
    const page = await closureRosterRoute(closureRosterClient(fetcher, actor), ref, cursor);
    if (missed) throw missed;
    return { page, requests };
  } finally { replay.dispose(); }
}

for (const persona of personas) {
  test(`${persona}: closed roster, featured and retained answers equal an absent Realm`, () => {
    for (const kind of ['roster', 'featured', 'first', 'retained']) {
      const closed = sample(persona, `closed-${kind}`), absent = sample(persona, `absent-${kind}`);
      expect(closed.status).toBe(absent.status);
      expect(closed.answer).toEqual(absent.answer);
      expect(closed.answer).toEqual({ status: 403, code: 'realm_operation_denied',
        title: 'Realm is unavailable', type: 'https://rezics.com/problems/realm_operation_denied' });
    }
  });

  test(`${persona}: members route conceals both the first page and retained continuation before reading names or counts`, async () => {
    const cursor = new URL(sample(persona, 'closed-retained').path, 'https://recorded.invalid').searchParams.get('after')!;
    for (const after of [undefined, cursor]) {
      const { page, requests } = await visit(persona, false, after);
      expect(isValidElement(page) && page.type).toBe(RealmNotFound);
      expect(about(page)).toBeNull();
      expect(requests.some(request => /\/roster|\/joining|\/zone/.test(request.url))).toBe(false);
      expect(sample(persona, 'members-private-header').answer).toMatchObject({
        status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' });
    }
  });

  test(`${persona}: production members page preserves consented identities, original name and featured credit`, async () => {
    const { page, requests } = await visit(persona, true);
    const shown = about(page);
    const roster = sample(persona, 'live-page-roster').answer as RealmRoster;
    const header = sample(persona, 'live-page-header').answer as RealmHeader;
    expect(shown?.realmName).toBe(header.name.value);
    expect(shown?.realmName).toBe(header.originalName?.value);
    expect(shown?.listed?.people.map(person => ({ id: person.id, name: person.name, href: person.href, featured: person.featured })))
      .toEqual(roster.items.map(item => ({ id: item.agent, name: item.displayName ?? messages.memberUnnamed,
        href: resourceHref('/a/', item.agent), featured: item.featured })));
    expect(roster.items).toHaveLength(2);
    expect(roster.items.filter(item => item.featured)).toHaveLength(1);
    expect(shown?.listed?.more).toBe(false);
    expect(shown?.members).toBeNull();
    const rosterRequest = requests.find(request => new URL(request.url).pathname.endsWith('/roster'))!;
    expect(new URL(rosterRequest.url).search).toBe('?limit=24');
    expect(rosterRequest.credentials).toBe('omit');
    expect(requests.filter(request => request.url.includes('/v1/me/')).every(request => request.credentials === 'same-origin')).toBe(true);
    expect(sample(persona, 'live-roster').answer).toEqual(roster);
  });
}

test('owner management roster and role-holder refusals keep their absent-Realm problems', () => {
  for (const kind of ['management-all', 'management-first', 'management-retained', 'management-search', 'management-role', 'roles']) {
    expect(sample('owner', `closed-${kind}`).status).toBe(404);
    expect(sample('owner', `closed-${kind}`).answer).toEqual(sample('owner', `absent-${kind}`).answer);
  }
});
