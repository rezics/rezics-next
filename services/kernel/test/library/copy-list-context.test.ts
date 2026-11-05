import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { attachCopyListContext } from '../../src/library/copy-list-context.ts';
import { createCopyListContextFixture } from './copy-list-context-fixture.ts';

const date = {
  time: '+2024-01-01T00:00:00Z',
  precision: 11,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
};

test('FULL copies keep native row identity and private metadata with only disclosed bounded Semantic context', async () => {
  const f = await createCopyListContextFixture();
  try {
    const author = await f.create('schema:Person', {}, { en: 'Public author' });
    const values = {
      'schema:author': author,
      'schema:datePublished': date,
      'schema:wordCount': { amount: '+123', unit: '1' },
    };
    const firstWork = await f.create('schema:Book', values, { en: 'Same title' });
    const secondWork = await f.create(
      'schema:Book',
      { ...values, 'schema:wordCount': { amount: '+456', unit: '1' } },
      { en: 'Same title' },
    );
    const hiddenWork = await f.create('schema:Book', values, { en: 'Hidden title' });
    const first = await f.copy(f.ownerToken, firstWork, 'private note one');
    const second = await f.copy(f.ownerToken, firstWork, 'private note two');
    const sibling = await f.copy(f.ownerToken, secondWork, 'sibling work copy');
    const hidden = await f.copy(f.ownerToken, hiddenWork, 'private hidden copy');
    const foreign = await f.copy(f.otherToken, firstWork, 'other account copy');
    await f.hide(hiddenWork);

    const basic = await f.page(f.ownerToken, 'BASIC');
    expect(basic.status).toBe(200);
    expect(JSON.stringify(await basic.json())).not.toContain('context');
    const response = await f.page(f.ownerToken);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      copies: Array<Record<string, any> & { subjectId: string }>;
      next: string | null;
    };
    expect(result.next).toBeNull();
    expect(result.copies.map((copy) => copy.id).sort()).toEqual([first.id, second.id, sibling.id, hidden.id].sort());
    expect(result.copies.find((copy) => copy.id === first.id)).toMatchObject({
      subjectId: firstWork,
      note: 'private note one',
      kind: 'physical',
      status: 'owned',
      acquiredOn: '2019-06-01',
      context: {
        state: 'unsupported',
        facts: {
          'schema:author': [{ kind: 'item', id: author, labels: { en: 'Public author' } }],
          'schema:datePublished': [{ kind: 'time', year: 2024 }],
          'schema:wordCount': [{ kind: 'quantity', amount: 123, unit: '1' }],
        },
      },
    });
    expect(result.copies.find((copy) => copy.id === second.id)?.subjectId).toBe(firstWork);
    expect(result.copies.find((copy) => copy.id === sibling.id)?.subjectId).toBe(secondWork);
    const hiddenRow = result.copies.find((copy) => copy.id === hidden.id)!;
    expect(hiddenRow).toMatchObject({ note: 'private hidden copy', context: { state: 'withheld' } });
    expect(JSON.stringify(hiddenRow.context)).not.toContain(hiddenWork);

    const otherPage = await f.page(f.otherToken);
    expect((await otherPage.json()).copies.map((copy: { id: string }) => copy.id)).toEqual([foreign.id]);
    expect((await f.page(null)).status).toBe(401);

    const unsupported = result.copies.find((copy) => copy.id === first.id)!;
    const deps = await f.deps('editor');
    const unavailableAccess = deriveAccess(deps.access, {
      async prepare() {
        throw new ProblemError('dependency_unavailable');
      },
    });
    const refreshed = await attachCopyListContext({ ...deps, access: unavailableAccess }, [unsupported], {
      revalidate: async () => {},
    });
    expect(refreshed[0]).toMatchObject({
      id: first.id,
      subjectId: firstWork,
      kind: 'physical',
      status: 'owned',
      revision: first.revision,
      note: 'private note one',
      context: { state: 'unavailable' },
    });
    const edit = await f.send(f.ownerToken, 'PATCH', `/v1/copies/${first.id}`, {
      revision: first.revision,
      note: 'edited while context unavailable',
    });
    expect(edit.status).toBe(200);
    expect((await edit.json()).copy).toMatchObject({ id: first.id, note: 'edited while context unavailable' });

    const changedRelease = structuredClone(bundledRelease);
    changedRelease.types['schema:Book']!.listPresentation!.keyFacts = ['schema:wordCount'];
    let releaseChangedDuringAssembly = false;
    const releaseAccess = deriveAccess(deps.access, {
      async prepare(actor, action, resource, context) {
        if (!releaseChangedDuringAssembly && action === 'subject:read' && resource.id === firstWork) {
          releaseChangedDuringAssembly = true;
          await f.publish(changedRelease);
        }
        return deps.access.prepare!(actor, action, resource, context);
      },
    });
    const currentnessMoved = await attachCopyListContext({ ...deps, access: releaseAccess }, [unsupported], {
      revalidate: async () => {},
    });
    expect(releaseChangedDuringAssembly).toBe(true);
    expect(currentnessMoved[0]).toMatchObject({
      id: first.id,
      subjectId: firstWork,
      context: { state: 'unavailable' },
    });

    const secondRevision = result.copies.find((copy) => copy.id === second.id)!.revision;
    const disposed = await f.send(f.ownerToken, 'PATCH', `/v1/copies/${second.id}`, {
      revision: secondRevision,
      status: 'disposed',
    });
    expect(disposed.status).toBe(200);
    const disposedCopy = (await disposed.json()).copy as { revision: number };
    const retired = structuredClone(bundledRelease);
    retired.libraryProfiles!['book.reading']!.copies!.kinds = [
      { id: 'digital', statuses: [{ id: 'owned', labels: { en: 'Owned' } }], labels: { en: 'Digital' } },
    ];
    await f.publish(retired);
    const retiredRow = (
      (await (await f.page(f.ownerToken)).json()).copies as Array<Record<string, any> & { subjectId: string }>
    ).find((copy) => copy.id === second.id);
    expect(retiredRow).toMatchObject({ kind: 'physical', status: 'disposed', context: { state: 'unsupported' } });

    await f.checked('POST', '/v1/platform/exposure/subject_identity:open', {}, 'operator');
    let movedDuringAssembly = false;
    const mergeAccess = deriveAccess(deps.access, {
      async prepare(actor, action, resource, context) {
        if (!movedDuringAssembly && action === 'subject:read' && resource.id === secondWork) {
          movedDuringAssembly = true;
          await f.checked('POST', '/v1/subjects:merge', { subjects: [secondWork, firstWork] });
        }
        return deps.access.prepare!(actor, action, resource, context);
      },
    });
    const moved = await attachCopyListContext({ ...deps, access: mergeAccess }, [retiredRow!], {
      revalidate: async () => {},
    });
    expect(movedDuringAssembly).toBe(true);
    expect(moved[0]).toMatchObject({ subjectId: secondWork, context: { state: 'unavailable' } });

    const removed = await f.send(f.ownerToken, 'DELETE', `/v1/copies/${second.id}?revision=${disposedCopy.revision}`);
    expect(removed.status).toBe(204);
    const remaining = ((await (await f.page(f.ownerToken)).json()).copies as Array<{ id: string }>).map(({ id }) => id);
    expect(remaining).not.toContain(second.id);
  } finally {
    await f.close();
  }
}, 180_000);

test('FULL Copies refuses revision or account epoch movement during Semantic assembly', async () => {
  const f = await createCopyListContextFixture();
  try {
    const subject = await f.create('schema:Book');
    const first = await f.copy(f.ownerToken, subject, 'visible page row');
    const second = await f.copy(f.ownerToken, subject, 'lookahead row');
    const basic = await f.page(f.ownerToken, 'BASIC', 1);
    expect(basic.status).toBe(200);
    const firstId = (await basic.json()).copies[0].id as string;
    const visible = first.id === firstId ? first : second;
    const outside = first.id === firstId ? second : first;
    const originalPrepare = f.access.prepare!.bind(f.access);
    async function changeDuringAssembly(copy: typeof first, note: string) {
      let changed = false;
      f.access.prepare = async (actor, action, resource, context) => {
        if (!changed && action === 'subject:read' && resource.id === subject) {
          changed = true;
          const edit = await f.send(f.ownerToken, 'PATCH', `/v1/copies/${copy.id}`, {
            revision: copy.revision,
            note,
          });
          expect(edit.status).toBe(200);
        }
        return originalPrepare(actor, action, resource, context);
      };
      const response = await f.page(f.ownerToken, 'FULL', 1);
      f.access.prepare = originalPrepare;
      expect(changed).toBe(true);
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('semantic_not_ready');
    }
    await changeDuringAssembly(visible, 'visible revision changed during assembly');
    await changeDuringAssembly(outside, 'lookahead revision changed during assembly');
  } finally {
    await f.close();
  }
}, 180_000);

test('FULL Copies refuses an account authentication fence raised during Semantic assembly', async () => {
  const f = await createCopyListContextFixture();
  try {
    const subject = await f.create('schema:Book');
    await f.copy(f.ownerToken, subject, 'fenced account copy');
    const originalPrepare = f.access.prepare!.bind(f.access);
    let fenced = false;
    f.access.prepare = async (actor, action, resource, context) => {
      if (!fenced && action === 'subject:read' && resource.id === subject) {
        fenced = true;
        await f.suspend(f.accounts.editor);
      }
      return originalPrepare(actor, action, resource, context);
    };
    const response = await f.page(f.ownerToken);
    f.access.prepare = originalPrepare;
    expect(fenced).toBe(true);
    expect(response.status).not.toBe(200);
  } finally {
    await f.close();
  }
}, 180_000);

test('raw copy overflow refuses before identity, summary or Semantic reads', async () => {
  const f = await createCopyListContextFixture();
  try {
    const deps = await f.deps('editor');
    const copies = Array.from({ length: 101 }, (_, index) => ({ subjectId: `not-read-${index}` }));
    await expect(attachCopyListContext(deps, copies, { revalidate: async () => {} })).rejects.toMatchObject({
      code: 'content_too_large',
    });
  } finally {
    await f.close();
  }
}, 180_000);
