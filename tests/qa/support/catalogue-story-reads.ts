import { missingCatalogueStates } from '../../../apps/web/features/zones/catalogue-browse-fixtures.ts';
import { expect } from 'bun:test';
import type { PersonaName, PersonaSession } from './personas.ts';
import type { OutcomeRecorder } from './outcome-test.ts';

/** Keep the story's query and label; only the fixture Realm is allocated by setup. */
export async function recordCatalogueStoryReads(recording: OutcomeRecorder, name: PersonaName,
  person: PersonaSession, realm: string, slug: 'anime' | 'games') {
  const sample = recording.session(name, person);
  for (const request of missingCatalogueStates.filter(request => request.slug === slug
    && (request.state === 'populated' || request.state === 'empty'))) {
    const url = new URL(request.path, 'http://main.local');
    const path = `/v1/realms/${realm.slice(-36)}/modules/browse${url.search}`;
    const response = await sample(request.label, request.method, path);
    const raw = await response.text();
    expect(response.status, `${path}: ${raw}`).toBe(200);
    const page = JSON.parse(raw) as { items: unknown[]; window: { complete: boolean } };
    if (request.state === 'populated') expect(page.items.length).toBeGreaterThan(0);
    else {
      expect(page.items).toEqual([]);
      expect(page.window.complete).toBe(true);
    }
  }
  // Lagging requires control of projection progress; error requires an unavailable
  // dependency; moved requires a changed read generation. Public commands cannot
  // arrange these states, and a fabricated contract cursor is not a continuation.
}

/** The fallback Zone route receives the cursor from this persona's own default page. */
export async function recordZoneBrowseContinuation(recording: OutcomeRecorder, name: PersonaName,
  person: PersonaSession, zone: string, cursor: string | null) {
  if (!cursor) return;
  const params = new URLSearchParams({ path: 'browse', cursor });
  if (person.actingSubject) params.set('actingSubject', person.actingSubject);
  const response = await recording.session(name, person)('page-browse-default-zone-continuation',
    'GET', `/v1/zones/${zone.slice(-36)}/routes?${params}`);
  await response.body?.cancel();
}
