import { expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { isValidElement, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/realm/closure-direct-routes.json';
import { mapZoneSiteHome } from '../zones/zone-site-recorded-page.ts';
import type { ZonePresentationRead } from './types.ts';
import { ZoneFrame } from '../zones/zone-frame.tsx';
import { RealmNotFound } from './states.tsx';
import { directEntries, directReplay, directRoute, directSample } from './realm-closure-direct-recorded-page.tsx';

const record = fixture as AnswerRecord;
const personas = Object.keys(record.personas) as AnswerPersona[];
function frame(node: ReactNode): React.ComponentProps<typeof ZoneFrame> | null {
  if (Array.isArray(node)) return node.map(frame).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === ZoneFrame ? node.props as React.ComponentProps<typeof ZoneFrame> : frame(node.props.children);
}

for (const persona of personas) {
  test(`${persona}: every direct closed answer preserves the absent status, code and title`, () => {
    for (const kind of ['realm-header', 'realm-works', 'realm-decisions', 'realm-decision', 'realm-zone', 'join-page']) {
      const closed = directSample(record, persona, `closed-${kind}`);
      expect(closed.status).toBe(404);
      expect(closed.answer).toEqual(directSample(record, persona, `absent-${kind}`).answer);
      expect(closed.answer).toMatchObject({ status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' });
      if (kind !== 'join-page') expect(directSample(record, persona, `live-${kind}`).status).toBe(200);
    }
    expect(directSample(record, persona, 'independent-work').status).toBe(200);
    const publication = directSample(record, persona, 'independent-publication');
    expect(publication.status).toBe(200);
    expect(publication.answer).toMatchObject({ body: 'An original fixture story by the owner Person, published independently.' });
  });

  for (const entry of directEntries) test(`${persona}: production ${entry} stops concealment before content reads and preserves the independent Zone`, async () => {
    const replay = directReplay(record, persona, entry);
    const requests: { path: string; credentials?: RequestCredentials }[] = [];
    let gap: unknown;
    const fetcher = (async (input, init) => {
      requests.push({ path: new Request(input, init).url, credentials: init?.credentials });
      try { return await replay.fetcher(input, init); } catch (error) { gap = error; throw error; }
    }) as typeof fetch;
    try {
      const page = await directRoute(record, persona, entry, fetcher);
      if (gap) throw gap;
      if (entry === 'zone-entry') {
        const shown = frame(page);
        expect(shown?.zone.realm).toBeNull();
        expect(shown?.zone.name.value).toBe('Outcome Realm site');
        expect(JSON.stringify(page)).toContain('An original published home for the Realm entry control.');
        expect(JSON.stringify(page)).toContain('original-contribution');
        const home = mapZoneSiteHome(directSample(record, persona, 'zone-entry-presentation').answer as ZonePresentationRead);
        if (home.kind !== 'published' || !home.credit) throw new Error('Recorded original credit is missing');
        expect(JSON.stringify(page)).toContain(home.credit.author);
        expect(shown?.members).toBeNull();
      } else {
        expect(isValidElement(page) && page.type).toBe(RealmNotFound);
        expect(frame(page)).toBeNull();
        expect(requests.some(request => /\/works|\/decisions|\/zone|\/joining|\/person-preferences/.test(request.path))).toBe(false);
        expect(requests.filter(request => /\/realms\//.test(request.path))).toHaveLength(2);
      }
      expect(requests.filter(request => request.path.includes('/addresses/') || request.path.includes('/join-page') || request.path.endsWith('/presentation'))
        .every(request => request.credentials === 'omit' || request.credentials === undefined)).toBe(true);
      expect(requests.filter(request => request.path.includes('/v1/me/') || request.path.includes('actingSubject='))
        .every(request => request.credentials === 'same-origin')).toBe(true);
    } finally { replay.dispose(); }
  });
}
