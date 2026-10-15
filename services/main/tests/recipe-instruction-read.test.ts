import { expect, test } from 'bun:test';
import { readRecipeInstructions } from '../src/modules/recipe/instructions.ts';
import { WorkReadSession, WorkReadMoved } from '../src/modules/work/read-session.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';

test('exact Post text stays available and duplicate uses share a read while retaining their order', async () => {
  const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const revision = '00000000-0000-4000-8000-000000000002';
  const variantId = `urn:rezics:variant:${revision}`;
  const first: OccurrenceRecord = { occurrence: target, parent: target, state: 'active', role: 'instruction',
    labels: [], target, introducedBy: target, selection: { mode: 'fixed-revision', revision,
      selector: { grain: 'content', revision, variantId } } };
  const second = { ...first, occurrence: target.replace(/001$/, '003') };
  let reads = 0;
  const session = { deps: { content: { readExactBatch: async (ids: string[]) => {
    reads++; expect(ids).toEqual([revision]);
    return [{ revisionId: revision, status: 'available', reference: { resourceId: target, variantId },
      body: { body: 'Exact original method.' } }];
  } } }, observeDependency() {} } as unknown as WorkReadSession;
  const instructions = await readRecipeInstructions(session, [first, second]);
  expect(reads).toBe(1);
  expect(instructions.map(item => item.occurrence)).toEqual([first.occurrence, second.occurrence]);
  expect(instructions.map(item => ({ status: item.status, text: item.text }))).toEqual([
    { status: 'available', text: 'Exact original method.' }, { status: 'available', text: 'Exact original method.' },
  ]);
});

function recordingPreview() {
  const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const asset = '00000000-0000-4000-8000-000000000002';
  const revision = '00000000-0000-4000-8000-000000000003';
  const representation = '00000000-0000-4000-8000-000000000004';
  const target = `urn:rezics:media:asset:${asset}`;
  const record: OccurrenceRecord = { occurrence: actor, parent: actor, state: 'active', role: 'instruction',
    labels: [], target, introducedBy: actor, selection: { mode: 'fixed-revision', revision,
      selector: { grain: 'representation', revision, representation, fragment: 't=npt:0,1' } } };
  const state = { manage: true, lifecycle: 'active', moderation: 'none', visible: true, retained: true };
  const selections: string[][] = [];
  const deps = { environment: { fuseki: { query: async () => ({ results: { bindings: [] } }) } },
    access: { canManageMedia: async () => state.manage }, media: { store: {
      readAsset: async () => ({ owner: actor, disclosure: 'private', state: 'head',
        lifecycle: state.lifecycle, moderation: state.moderation }),
      referenceSelection: async (...ids: string[]) => {
        selections.push(ids); return state.retained ? { duration: 2 } : null;
      },
    } } } as unknown as MainWorkDependencies;
  configureDisclosure(deps.environment, { read: async targets => targets.map(() => state.visible ? 'visible' : 'hidden') });
  const session = new WorkReadSession(deps, new Request('http://localhost/recipe'),
    { actingSubject: actor }, { dataEpoch: 'fixture', sequence: '1' });
  session.principal = { issuer: 'https://accounts.example', subject: 'owner' };
  const read = () => readRecipeInstructions(session, [record], { work: actor, revision: actor, admitted: true });
  return { read, session, record, state, selections,
    reference: { target, selector: { grain: 'representation' as const, revision, representation, fragment: 't=npt:0,1' } },
    ids: [asset, revision, representation] };
}

test('private instruction preview resolves the exact retained recording without a publication Use', async () => {
  const f = recordingPreview();
  expect(await f.read()).toEqual([{ occurrence: f.record.occurrence,
    reference: f.reference, status: 'available' }]);
  expect(f.selections).toEqual([f.ids]);
  await f.session.fenceDependencies();
  f.state.manage = false;
  await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('private recording preview retains owner, lifecycle, exact membership and disclosure restrictions', async () => {
  for (const restriction of [{ manage: false }, { lifecycle: 'erased' }, { moderation: 'suppressed' },
    { retained: false }, { visible: false }]) {
    const f = recordingPreview(); Object.assign(f.state, restriction);
    expect((await f.read())[0]?.status).toBe('unavailable');
  }
});

test('a private recording fragment must still belong to the exact retained duration', async () => {
  const f = recordingPreview();
  if (f.record.selection?.mode !== 'fixed-revision' || f.record.selection.selector?.grain !== 'representation') {
    throw new Error('Fixture must select a recording');
  }
  f.record.selection.selector.fragment = 't=npt:0,3';
  expect((await f.read())[0]?.status).toBe('unavailable');
});
