import { expect } from 'bun:test';
import type { CollectionView } from '../../../src/library/collection-reads.ts';
import { createCollectionPresentationFixture } from './collection-presentation-fixture.ts';

/** Native Auth, subject/Collection commands and the default worker; no injected observations or Access verdicts. */
export async function createCollectionKindFixture() {
  const native = await createCollectionPresentationFixture();
  const path = (id: string) => `/v1/collections/${id}`;

  async function subject(type: string) {
    const response = await native.send(native.owner.bearer, 'POST', '/v1/subjects', {
      type,
      labels: { en: `Collection member ${type}` },
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { subject: { id: string } }).subject.id;
  }

  async function add(collectionId: string, subjectId: string) {
    const response = await native.send(native.owner.bearer, 'POST', `${path(collectionId)}/members`, { subjectId });
    expect(response.status).toBe(201);
    return ((await response.json()) as { member: { id: string } }).member.id;
  }

  async function read(collectionId: string, bearer: string | null = native.owner.bearer) {
    const response = await native.send(bearer, 'GET', path(collectionId));
    expect(response.status).toBe(200);
    return ((await response.json()) as { collection: CollectionView }).collection;
  }

  // GET is deliberately the only operation here: work must originate in native mutation/repair boundaries.
  // A bounded wait permits real asynchronous delivery; it never fabricates completion or starts repair itself.
  async function complete(collectionId: string, bearer: string | null = native.owner.bearer) {
    const deadline = Date.now() + 30_000;
    let row = await read(collectionId, bearer);
    while (row.presentationKindSource === 'pending' && Date.now() < deadline) {
      await Bun.sleep(50);
      row = await read(collectionId, bearer);
    }
    expect(row.presentationKindSource).not.toBe('pending');
    return row;
  }

  async function patch(collectionId: string, selection: string | null) {
    const current = await read(collectionId);
    const response = await native.send(native.owner.bearer, 'PATCH', path(collectionId), {
      revision: current.revision,
      presentationKind: selection,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { collection: CollectionView }).collection;
  }

  async function hide(subjectId: string) {
    const response = await native.send(native.manager.bearer, 'POST', `/v1/subjects/${subjectId}:hide`, {
      reason: 'Exclude a currently hidden original from Collection presentation',
    });
    expect(response.status).toBe(200);
  }

  return { ...native, path, subject, add, read, complete, patch, hide };
}

export type CollectionKindFixture = Awaited<ReturnType<typeof createCollectionKindFixture>>;
