import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { identitySupport } from '../../imports/identity-fixture.ts';
import { selectLibraryProfile } from '../../../src/library/profile.ts';
import { createCollectionPresentationFixture } from './collection-presentation-fixture.ts';

const scopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'library_entry:read',
  'library_entry:update',
  'library_entry:delete',
  'progress_session:read',
  'progress_session:create',
  'progress_session:update',
  'copy:read',
  'copy:create',
  'copy:update',
  'subject:read',
  'subject:create',
];

/** Positive facts and credentials all enter through the real Auth and product APIs. */
export async function createCollectionRulesFixture() {
  const base = await createCollectionPresentationFixture();
  try {
    const support = identitySupport(base.runtime.identity);
    const clientId = `collection-rules-${randomUUID()}`;
    await base.runtime.identity.auth.internal.registerClient({ clientId, firstParty: true, scopes });
    async function credential(person = 'ordinary', requested = scopes) {
      const signed = await support.request('/signin', {
        email: `${person}@identity.test`,
        password: 'private native identity fixture password',
        client_id: clientId,
        scope: requested,
      });
      expect(signed.status).toBe(200);
      const issued = await support.request(
        '/token',
        {},
        new Headers({
          cookie: signed.headers
            .getSetCookie()
            .map((value) => value.split(';')[0]!)
            .join('; '),
        }),
      );
      expect(issued.status).toBe(200);
      return ((await issued.json()) as { access_token: string }).access_token;
    }
    const owner = await credential();
    const other = await credential('another');
    const reduced = await credential(
      'ordinary',
      scopes.filter((scope) => scope !== 'library_entry:read'),
    );
    for (const group of ['personal_library', 'reading_progress'])
      expect((await base.send(base.manager.bearer, 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
    const send = (method: string, path: string, body?: unknown, bearer: string | null = owner, key = randomUUID()) =>
      base.send(bearer, method, path, body, key);
    const profile = selectLibraryProfile(bundledRelease, 'schema:Book');
    if (!profile?.entryStateSet?.states.length) throw new Error('Released Book entry states are required');
    const state = profile.entryStateSet.states[0]!.id;
    async function subject(title: string) {
      const response = await send('POST', '/v1/subjects', { type: 'schema:Book', labels: { en: title } });
      expect(response.status).toBe(201);
      return ((await response.json()) as { subject: { id: string } }).subject.id;
    }
    async function entry(subjectId: string) {
      const response = await send('PUT', `/v1/libraryEntries/${subjectId}`, { state });
      expect(response.status).toBe(201);
      return (await response.json()).libraryEntry;
    }
    async function page(collectionId: string) {
      // A finite fixture must complete through the actual default preparation worker, if preparation is needed.
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await send('GET', `/v1/collections/${collectionId}/members`);
        if (response.status !== 202) {
          expect(response.status).toBe(200);
          return response.json();
        }
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('retry-after')).not.toBeNull();
        expect(await response.json()).toEqual({ preparing: true });
        await Bun.sleep(10);
      }
      throw new Error('Finite saved Collection preparation never reached a useful page');
    }
    return { ...base, owner, other, reduced, send, subject, entry, page, profile, state, credential };
  } catch (error) {
    await base.close();
    throw error;
  }
}
export type CollectionRulesFixture = Awaited<ReturnType<typeof createCollectionRulesFixture>>;
