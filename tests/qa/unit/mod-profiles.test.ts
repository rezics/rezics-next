import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { ModProfileInvalid, type ModCapture, type ModRequest, solveModCaptures }
  from '../../../services/main/src/modules/package/mod-profile.ts';

function observed(identity: string, surface: string, document: unknown): ModCapture {
  const raw = typeof document === 'string' ? document : JSON.stringify(document);
  const bytes = Buffer.from(raw);
  return { identity, surface, status: 'observed', bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
function request(ecosystem: ModRequest['ecosystem'], root: string, captures: ModCapture[],
  side: ModRequest['side'] = 'CLIENT'): ModRequest {
  return { profile: 'mod-native-capture-v1', ecosystem, root, captures, side,
    ...(ecosystem === 'forge' || ecosystem === 'neoforge'
      ? { runtime: { loaderVersion: '52', gameVersion: '1.21.1' } } : {}) };
}

describe('mod native capture profiles', () => {
  test('PKG07 Fabric conflicts warn while breaks fail', () => {
    const other = observed('other', 'manifest', { schemaVersion: 1, id: 'other', version: '1.0.0' });
    const soft = solveModCaptures(request('fabric', 'root', [
      observed('root', 'manifest', { schemaVersion: 1, id: 'root', version: '1.0.0',
        conflicts: { other: '*' }, recommends: { absent: '*' }, suggests: { hint: '*' } }), other]));
    expect(soft.selection).toBe('valid');
    expect(soft.issues.map(issue => issue.kind)).toEqual(['advisory-missing', 'advisory-conflict']);
    expect(soft.relations.find(edge => edge.kind === 'suggests')?.strength).toBe('metadata');
    const hard = solveModCaptures(request('fabric', 'root', [
      observed('root', 'manifest', { schemaVersion: 1, id: 'root', version: '1.0.0',
        breaks: { other: '*' } }), other]));
    expect(hard.selection).toBe('unsatisfiable');
    expect(hard.issues[0]?.kind).toBe('hard-constraint');
    const runtime = solveModCaptures({ ...request('fabric', 'root', [observed('root', 'manifest',
      { schemaVersion: 1, id: 'root', version: '1.0.0',
        depends: { minecraft: '>=1.21', fabricloader: '>=0.16' } })]),
      runtime: { loaderVersion: '0.16.0', gameVersion: '1.21.1' } });
    expect(runtime.selection).toBe('valid');
  });

  test('PKG08 Forge/NeoForge keep different fields, sides, ranges and ordering cycles', () => {
    const forgeRoot = `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[[dependencies.root]]\nmodId="other"\nmandatory=true\nversionRange="[2.0,3.0)"\nordering="BEFORE"\nside="CLIENT"`;
    const forgeOther = `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="other"\nversion="2.1.0"\n[[dependencies.other]]\nmodId="root"\nmandatory=false\nversionRange="[1.0,2.0)"\nordering="BEFORE"\nside="CLIENT"`;
    const captures = [observed('root', 'manifest', forgeRoot), observed('other', 'manifest', forgeOther)];
    const client = solveModCaptures(request('forge', 'root', captures));
    expect(client.selection).toBe('valid');
    expect(client.ordering).toBe('cycle');
    const server = solveModCaptures(request('forge', 'root', captures, 'SERVER'));
    expect(server.selection).toBe('valid');
    expect(server.ordering).toBe('valid');
    const neo = solveModCaptures(request('neoforge', 'root', [observed('root', 'manifest',
      `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[[dependencies.root]]\nmodId="other"\ntype="incompatible"\nversionRange="[2.0,3.0)"\nside="SERVER"`),
      observed('other', 'manifest', forgeOther.replace('mandatory=false', 'type="optional"'))], 'SERVER'));
    expect(neo.selection).toBe('unsatisfiable');
    expect(solveModCaptures(request('forge', 'root', [captures[0]!])).selection)
      .toBe('incomplete-source-data');
    expect(solveModCaptures(request('neoforge', 'root', [captures[0]!])).selection)
      .toBe('unsupported-semantics');
    const wrongRuntime = solveModCaptures({ ...request('forge', 'root', captures),
      runtime: { loaderVersion: '51', gameVersion: '1.21.1' } });
    expect(wrongRuntime.selection).toBe('unsatisfiable');
  });

  test('PKG09 Modrinth and CurseForge retain embedded, optional and required grain', () => {
    const modrinth = solveModCaptures(request('modrinth', 'V1', [
      observed('V1', 'version', { id: 'V1', project_id: 'P1', dependencies: [
        { version_id: 'V2', project_id: 'P2', dependency_type: 'embedded' },
        { version_id: 'V3', project_id: 'P3', dependency_type: 'required' },
        { version_id: null, project_id: 'P4', dependency_type: 'optional' },
      ] }),
      observed('V2', 'version', { id: 'V2', project_id: 'P2', dependencies: [] }),
      observed('V3', 'version', { id: 'V3', project_id: 'P3', dependencies: [] }),
    ]));
    expect(modrinth.selection).toBe('valid');
    expect(modrinth.independentDownloads).toEqual(['V1', 'V3']);
    expect(modrinth.relations).toHaveLength(3);
    const curseforge = solveModCaptures(request('curseforge', '101', [
      observed('101', 'file', { id: 101, modId: 10, dependencies: [
        { modId: 20, relationType: 1 }, { modId: 30, relationType: 3 },
        { modId: 40, relationType: 4 }, { modId: 50, relationType: 6 },
      ] }), observed('201', 'file', { id: 201, modId: 20, dependencies: [] }),
      observed('301', 'file', { id: 301, modId: 30, dependencies: [] }),
    ]));
    expect(curseforge.selection).toBe('valid');
    expect(curseforge.independentDownloads).toEqual(['101', '301']);
    expect(curseforge.relations.map(edge => edge.kind))
      .toEqual(['embedded', 'required', 'tool', 'include']);
    expect(curseforge.relations.at(-1)?.strength).toBe('metadata');
  });

  test('PKG10 inaccessible Nexus range is recorded as incomplete, never empty', () => {
    const outcome = solveModCaptures(request('nexus', 'game/mod/file', [
      { identity: 'game/mod/file', surface: 'file-version-range', status: 'inaccessible',
        bytesBase64: null, sha256: null },
    ]));
    expect(outcome.selection).toBe('incomplete-source-data');
    expect(outcome.coverage).toEqual([{ identity: 'game/mod/file',
      surface: 'file-version-range', status: 'inaccessible', sha256: null }]);
    expect(outcome.relations).toEqual([]);
  });

  test('PKG11 Steam item dependency is soft; Collection membership is distinct', () => {
    const item = solveModCaptures(request('steam', '123', [observed('123', 'ugc-children',
      { publishedfileid: '123', file_type: 0, num_children: 1, children: [{ publishedfileid: '456' }] })]));
    expect(item.selection).toBe('valid');
    expect(item.relations[0]?.strength).toBe('advisory');
    const collection = solveModCaptures(request('steam', '123', [observed('123', 'ugc-children',
      { publishedfileid: '123', file_type: 2, num_children: 1, children: [{ publishedfileid: '456' }] })]));
    expect(collection.selection).toBe('valid');
    expect(collection.relations[0]?.strength).toBe('collection');
    expect(collection.issues).toEqual([]);
    expect(solveModCaptures(request('steam', '123', [observed('123', 'ugc-children',
      { publishedfileid: '123', file_type: 0, num_children: 2,
        children: [{ publishedfileid: '456' }] })])).selection).toBe('unsupported-semantics');
  });

  test('PKG09/PKG10 unsupported provider clauses do not become empty dependencies', () => {
    const fileOnly = solveModCaptures(request('modrinth', 'V1', [observed('V1', 'version',
      { id: 'V1', project_id: 'P1', dependencies: [{ project_id: null,
        version_id: null, file_name: 'external.jar', dependency_type: 'required' }] })]));
    expect(fileOnly.selection).toBe('unsupported-semantics');
    const experimental = solveModCaptures(request('nexus', 'game/mod/file', [
      observed('game/mod/file', 'file-version-range', { dependencies: [] })]));
    expect(experimental.selection).toBe('unsupported-semantics');
    expect(experimental.coverage[0]?.status).toBe('observed');
  });

  test('PKG07-PKG11 bad digest and duplicate identities cannot create a solved outcome', () => {
    const one = observed('root', 'manifest', { schemaVersion: 1, id: 'root', version: '1.0.0' });
    expect(() => solveModCaptures(request('fabric', 'root', [{ ...one, sha256: '0'.repeat(64) }])))
      .toThrow(ModProfileInvalid);
    expect(() => solveModCaptures(request('fabric', 'root', [one, one])))
      .toThrow(ModProfileInvalid);
    expect(() => solveModCaptures(request('nexus', '1', [{ identity: '1',
      surface: 'file-version-range', status: 'inaccessible', bytesBase64: null,
      sha256: null, sourceUrl: 'https://api.nexusmods.com/v3/mod-file-versions/1/dependencies/ranges?key=secret',
    }]))).toThrow(ModProfileInvalid);
  });

  test('PKG07-PKG11 bounded counters grow with captures and relations only', () => {
    const root = observed('root', 'manifest', { schemaVersion: 1, id: 'root', version: '1.0.0',
      recommends: { child: '*' } });
    for (const unrelated of [1, 4, 16]) {
      const captures = [root, ...Array.from({ length: unrelated }, (_, index) =>
        observed(`n${index}`, 'manifest', { schemaVersion: 1,
          id: `n${index}`, version: '1.0.0' }))];
      const outcome = solveModCaptures(request('fabric', 'root', captures));
      expect(outcome.cost.captures).toBe(unrelated + 1);
      expect(outcome.cost.relations).toBe(1);
      expect(outcome.cost.comparisons).toBe(1);
    }
    const overLimit = solveModCaptures(request('fabric', 'root', [root,
      ...Array.from({ length: 32 }, (_, index) => observed(`n${index}`, 'manifest',
        { schemaVersion: 1, id: `n${index}`, version: '1.0.0' }))]));
    expect(overLimit.selection).toBe('budget-exhausted');
    expect(overLimit.relations).toEqual([]);
    const wide = solveModCaptures(request('fabric', 'root', [observed('root', 'manifest',
      { schemaVersion: 1, id: 'root', version: '1.0.0',
        recommends: Object.fromEntries(Array.from({ length: 128 }, (_, index) =>
          [`n${index}`, '*'])) })]));
    expect(wide.selection).toBe('valid');
    expect(wide.cost.relations).toBe(128);
    expect(wide.cost.comparisons).toBe(128);
  });
});
