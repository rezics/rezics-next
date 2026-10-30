import { expect } from 'bun:test';
import type { CollectionView } from '../../../src/library/collection-reads.ts';
import type { SubjectSummary } from '../../../src/semantic/summaries.ts';
import { createProfileEntryFixture, entryKey } from './profile-entry-fixture.ts';

export type PreviewCollection = CollectionView & {
  previewStatus?: 'ready' | 'pending';
  previewMembers?: { subjectId: string; subject: SubjectSummary }[];
};
export type PreviewPage = { collections: PreviewCollection[]; next: string | null };

/** All positive product data enters through the mounted native APIs and their real Access. */
export async function createCollectionPreviewFixture() {
  const native = await createProfileEntryFixture({ projectLinks: false });
  try {
    const scopes = ['subject:read', 'collection:create', 'collection:read', 'collection:update', 'collection:delete'];
    const owner = await native.identity(scopes);
    const other = await native.identity(scopes);
    expect((await native.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);

    async function collection(visibility: 'private' | 'public' = 'private', bearer = owner.bearer) {
      const response = await native.send(bearer, 'POST', '/v1/collections', { title: entryKey(), visibility });
      expect(response.status).toBe(201);
      return ((await response.json()) as { collection: CollectionView }).collection;
    }

    async function append(collectionId: string, subjectId: string, after: string | null = null) {
      const response = await native.send(owner.bearer, 'POST', `/v1/collections/${collectionId}/members`, {
        subjectId,
        note: 'Private occurrence annotation must never enter the preview',
        after,
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { member: { id: string } }).member.id;
    }

    async function populate(collectionId: string, subjectIds: readonly string[]) {
      let after: string | null = null;
      for (const subjectId of subjectIds) after = await append(collectionId, subjectId, after);
    }

    function list(bearer = owner.bearer, suffix = '&view=FULL&preview=3&limit=20') {
      return native.send(bearer, 'GET', `/v1/collections?curatorAccountId=${owner.actor.accountId}${suffix}`);
    }

    async function page(bearer = owner.bearer, suffix?: string): Promise<PreviewPage> {
      const response = await list(bearer, suffix);
      expect(response.status).toBe(200);
      return response.json();
    }

    async function hide(subjectId: string) {
      expect(
        (await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, { reason: 'Preview disclosure' }))
          .status,
      ).toBe(200);
    }

    return { ...native, previewOwner: owner, previewOther: other, collection, append, populate, list, page, hide };
  } catch (error) {
    await native.close();
    throw error;
  }
}

export type CollectionPreviewFixture = Awaited<ReturnType<typeof createCollectionPreviewFixture>>;

export function expectReadyPreview(row: PreviewCollection | undefined, subjects: readonly string[]) {
  expect(row).toBeDefined();
  expect(row!.previewStatus).toBe('ready');
  expect(row!.previewMembers).toHaveLength(subjects.length);
  expect(row!.previewMembers!.map((member) => member.subjectId)).toEqual([...subjects]);
  for (const member of row!.previewMembers!) {
    expect(member.subject.id).toBe(member.subjectId);
    expect(member.subject.types).toContain(member.subject.type);
    expect(Object.hasOwn(member, 'note')).toBe(false);
    expect(Object.hasOwn(member, 'facts')).toBe(false);
  }
}
