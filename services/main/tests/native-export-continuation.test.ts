import { expect, test } from 'bun:test';
import { assembleNativeExport, continueNativeExport, nativeExportCheckpoint, type NativeExportPage } from '@rezics/model/native-export';

test('native checkpoints retain custom containers, ordered uses and dependency pages across a restart', async () => {
  const root = 'structure', child = 'section';
  const reference = { target: 'post', selector: { grain: 'content', revision: 'content-exact' } };
  const page = (parent: string, next: string | null, containers: string[], contents: NativeExportPage['contents']): NativeExportPage => ({
    structure: root, revision: 'revision-exact', parent, next, containers, contents,
    occurrences: [{ parent }], rights: [{ result: 'undetermined' }], measures: [],
  });
  const checkpoint = nativeExportCheckpoint(root);
  let calls = 0;
  const read = async (parent: string, after?: string) => {
    if (++calls === 2) throw new Error('offline');
    return parent === root ? page(root, after ? null : 'cut', after ? [] : [child], [])
      : page(child,null,[],[{ reference,body: 'Exact private Content' }]);
  };
  await expect(continueNativeExport(checkpoint,read,async () => { throw new Error('too early'); })).rejects.toThrow('offline');
  expect(checkpoint.after).toBe('cut');
  const restored = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
  await expect(continueNativeExport(restored,read,async (revision,cursor) => {
    expect(revision).toBe('content-exact');
    if (cursor) throw new Error('dependency offline');
    return { items: ['credit 1'],nextCursor: 'credits-cut' };
  })).rejects.toThrow('dependency offline');
  await continueNativeExport(restored,async () => { throw new Error('must not reread'); },async (_revision,cursor) => {
    expect(cursor).toBe('credits-cut'); return { items: ['credit 2'],nextCursor: null };
  });
  expect(assembleNativeExport(restored.pages,restored.derivations)).toMatchObject({ revision: 'revision-exact',
    occurrences: [{ parent: root },{ parent: root },{ parent: child }],
    contents: [{ reference,body: 'Exact private Content' }],derivations: ['credit 1','credit 2'] });
});

test('a changed revision or cyclic container cannot advance a native checkpoint', async () => {
  const checkpoint = nativeExportCheckpoint('structure');
  const page: NativeExportPage = { structure: 'structure',revision: 'exact',parent: 'structure',next: 'cut',
    occurrences: [],contents: [],measures: [],rights: [] };
  await expect(continueNativeExport(checkpoint,async (_parent,after) => after ? { ...page,revision: 'moved' } : page,
    async () => { throw new Error('no Content'); })).rejects.toThrow('Invalid native export continuation');
  expect(checkpoint.pages).toHaveLength(1);
  const empty = nativeExportCheckpoint('structure');
  await expect(continueNativeExport(empty,async () => ({ ...page,containers: ['structure'] }),
    async () => { throw new Error('no Content'); })).rejects.toThrow('Invalid native export containers');
  expect(empty.pages).toHaveLength(0);
});
