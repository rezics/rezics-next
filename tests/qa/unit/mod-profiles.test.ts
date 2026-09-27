import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { ModProfileInvalid, type ModCapture, type ModRequest, solveModCaptures }
  from '../../../services/main/src/modules/package/mod-profile.ts';
import { fixtureJar } from '../fixtures/mod-native-oracle/zip.ts';

function observed(identity: string, surface: string, document: unknown): ModCapture {
  const raw = typeof document === 'string' ? document : JSON.stringify(document);
  const bytes = Buffer.from(raw);
  return { identity, surface, status: 'observed', bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
function binary(identity: string, surface: string, bytes: Buffer): ModCapture {
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
  test('PKG07: native Fabric side filtering and declared nested child', () => {
    const clientOnly = observed('root', 'manifest', { schemaVersion: 1, id: 'root',
      version: '1.0.0', environment: 'client', depends: { missing: '*' } });
    const server = solveModCaptures(request('fabric', 'root', [clientOnly], 'SERVER'));
    expect(server.selection).toBe('valid');
    expect(server.independentDownloads).toEqual([]);
    expect(server.cost.comparisons).toBe(0);
    expect(solveModCaptures(request('fabric', 'root', [clientOnly])).selection)
      .toBe('incomplete-source-data');
    const sideDependency = solveModCaptures(request('fabric', 'parent', [
      observed('parent', 'manifest', { schemaVersion: 1, id: 'parent',
        version: '1.0.0', depends: { child: '*' } }),
      observed('child', 'manifest', { schemaVersion: 1, id: 'child',
        version: '1.0.0', environment: 'client' }),
    ], 'SERVER'));
    expect(sideDependency.selection).toBe('unsatisfiable');
    expect(sideDependency.issues[0]?.kind).toBe('target-skipped-on-side');

    const parent = observed('parent', 'manifest', { schemaVersion: 1, id: 'parent',
      version: '1.0.0', jars: [{ file: 'META-INF/jars/child.jar' }],
      depends: { child: '*' } });
    const child = { ...observed('child', 'manifest', { schemaVersion: 1, id: 'child',
      version: '1.0.0' }), nestedOf: 'parent', nestedPath: 'META-INF/jars/child.jar' };
    const archive = (nestedManifest: ModCapture, deflate = false): ModCapture => binary('parent', 'archive', fixtureJar([
      ['fabric.mod.json', Buffer.from(parent.bytesBase64!, 'base64')],
      ['META-INF/jars/child.jar', fixtureJar([
        ['fabric.mod.json', Buffer.from(nestedManifest.bytesBase64!, 'base64')],
      ], deflate)],
    ], deflate));
    const nested = solveModCaptures(request('fabric', 'parent', [parent, child, archive(child)]));
    expect(nested.selection).toBe('valid');
    expect(nested.independentDownloads).toEqual(['parent']);
    expect(nested.relations.find(edge => edge.kind === 'nested-jar'))
      .toMatchObject({ from: 'parent', to: 'child', strength: 'embedded' });
    expect(solveModCaptures(request('fabric', 'parent', [child, archive(child), parent]))
      .selection).toBe('valid');
    expect(solveModCaptures(request('fabric', 'parent', [parent, child, archive(child, true)]))
      .selection).toBe('valid');
    expect(solveModCaptures(request('fabric', 'parent', [parent])).issues[0]?.kind)
      .toBe('nested-jar-unobserved');
    expect(solveModCaptures(request('fabric', 'parent', [parent, child])).issues[0]?.kind)
      .toBe('nested-parent-archive-unobserved');
    const missingEntry = binary('parent', 'archive', fixtureJar([
      ['fabric.mod.json', Buffer.from(parent.bytesBase64!, 'base64')],
    ]));
    expect(solveModCaptures(request('fabric', 'parent', [parent, child, missingEntry]))
      .issues[0]?.kind).toBe('nested-jar-missing-from-archive');
    const damaged = Buffer.from(archive(child).bytesBase64!, 'base64');
    damaged[damaged.indexOf('"id":"child"') + 6] ^= 1;
    expect(() => solveModCaptures(request('fabric', 'parent', [parent, child,
      binary('parent', 'archive', damaged)]))).toThrow(ModProfileInvalid);
    expect(() => solveModCaptures(request('fabric', 'parent', [parent,
      { ...child, bytesBase64: observed('child', 'manifest', { schemaVersion: 1,
        id: 'child', version: '2.0.0' }).bytesBase64,
        sha256: observed('child', 'manifest', { schemaVersion: 1,
          id: 'child', version: '2.0.0' }).sha256 }, archive(child)])))
      .toThrow(ModProfileInvalid);
    const clientParent = observed('parent', 'manifest', { schemaVersion: 1,
      id: 'parent', version: '1.0.0', environment: 'client',
      jars: [{ file: 'META-INF/jars/child.jar' }] });
    expect(solveModCaptures(request('fabric', 'parent', [clientParent], 'SERVER')).selection)
      .toBe('valid');
    const unsatisfiedChild = { ...observed('child', 'manifest', { schemaVersion: 1,
      id: 'child', version: '1.0.0', depends: { absent: '*' } }),
      nestedOf: 'parent', nestedPath: 'META-INF/jars/child.jar' };
    expect(solveModCaptures(request('fabric', 'parent', [parent, unsatisfiedChild,
      archive(unsatisfiedChild)])).selection)
      .toBe('incomplete-source-data');
    expect(() => solveModCaptures(request('fabric', 'parent', [parent,
      { ...child, nestedPath: 'other.jar' }]))).toThrow(ModProfileInvalid);
  });

  test('PKG08: native feature side and NeoForge conditional mixin semantics', () => {
    const forgeManifest = `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\nclientSideOnly=true\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[features.root]\nopenGLVersion="[3.2,)"`;
    const base = request('forge', 'root', [observed('root', 'manifest', forgeManifest)]);
    const client = solveModCaptures({ ...base,
      runtime: { ...base.runtime!, features: { openGLVersion: '3.1' } } });
    expect(client.selection).toBe('unsatisfiable');
    expect(client.issues[0]?.kind).toBe('hard-constraint');
    const server = solveModCaptures({ ...base, side: 'SERVER' });
    expect(server.selection).toBe('valid');
    expect(server.independentDownloads).toEqual([]);

    const neoManifest = `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[features.root]\nopenGLVersion="[3.2,)"\n[[mixins]]\nconfig="root.mixins.json"\nrequiredMods=["other"]`;
    const neo = request('neoforge', 'root', [observed('root', 'manifest', neoManifest)]);
    const noFeature = solveModCaptures(neo);
    expect(noFeature.selection).toBe('unsupported-semantics');
    expect(noFeature.issues[0]?.kind).toBe('feature-runtime-unbound');
    const withFeature = solveModCaptures({ ...neo,
      runtime: { ...neo.runtime!, features: { openGLVersion: '3.2' } } });
    expect(withFeature.selection).toBe('valid');
    expect(withFeature.relations.find(edge => edge.kind === 'mixin-conditional:root.mixins.json'))
      .toMatchObject({ to: 'other', strength: 'metadata' });
    expect(withFeature.issues).toEqual([]);
    const reciprocalMixin = observed('other', 'manifest',
      'modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="other"\nversion="1.0.0"\n[[mixins]]\nconfig="other.mixins.json"\nrequiredMods=["root"]');
    const conditionalPair = solveModCaptures({ ...neo,
      captures: [...neo.captures, reciprocalMixin],
      runtime: { ...neo.runtime!, features: { openGLVersion: '3.2' } } });
    expect(conditionalPair.selection).toBe('valid');
    expect(conditionalPair.ordering).toBe('valid');
    const neoServer = solveModCaptures({ ...neo, side: 'SERVER' });
    expect(neoServer.selection).toBe('valid');
    expect(neoServer.cost.comparisons).toBe(1);
  });

  test('PKG08: optional loader dependency is hard when an installed version is outside range', () => {
    for (const ecosystem of ['forge', 'neoforge'] as const) {
      const field = ecosystem === 'forge' ? 'mandatory=false' : 'type="optional"';
      const root = `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[[dependencies.root]]\nmodId="other"\n${field}\nversionRange="[2.0,3.0)"\nside="BOTH"`;
      const other = 'modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="other"\nversion="1.0.0"';
      const absent = solveModCaptures(request(ecosystem, 'root', [observed('root', 'manifest', root)]));
      expect(absent.selection).toBe('valid');
      const installed = solveModCaptures(request(ecosystem, 'root', [
        observed('root', 'manifest', root), observed('other', 'manifest', other)]));
      expect(installed.selection).toBe('unsatisfiable');
      expect(installed.issues[0]?.kind).toBe('hard-constraint');
    }
  });

  test('PKG07: Fabric conflicts warn while breaks fail', () => {
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

  test('PKG07: Fabric provided IDs and alternative ranges follow native resolver limits', () => {
    const provider = observed('provider', 'manifest', { schemaVersion: 1,
      id: 'provider', version: '2.1.0', provides: ['alias'] });
    const aliasUser = observed('alias_user', 'manifest', { schemaVersion: 1,
      id: 'alias_user', version: '1.0.0', depends: { alias: '*' } });
    const arrayUser = observed('array_user', 'manifest', { schemaVersion: 1,
      id: 'array_user', version: '1.0.0',
      depends: { provider: ['>=3.0.0', '^2.0.0'] } });
    const outcome = solveModCaptures(request('fabric', 'provider',
      [provider, aliasUser, arrayUser]));
    expect(outcome.selection).toBe('valid');
    expect(outcome.relations.find(edge => edge.from === 'array_user')?.range)
      .toEqual(['>=3.0.0', '^2.0.0']);
    const rangedAlias = observed('alias_user', 'manifest', { schemaVersion: 1,
      id: 'alias_user', version: '1.0.0', depends: { alias: '[2.0,3.0)' } });
    const conservative = solveModCaptures(request('fabric', 'provider', [provider, rangedAlias]));
    expect(conservative.selection).toBe('unsupported-semantics');
    expect(conservative.issues[0]?.kind).toBe('provided-version-unqualified');
  });

  test('PKG08: Forge/NeoForge keep different fields, sides, ranges and ordering cycles', () => {
    const forgeRoot = `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[[dependencies.root]]\nmodId="other"\nmandatory=true\nversionRange="[2.0,3.0)"\nordering="BEFORE"\nside="CLIENT"`;
    const forgeOther = `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="other"\nversion="2.1.0"\n[[dependencies.other]]\nmodId="root"\nmandatory=false\nversionRange="[1.0,2.0)"\nordering="BEFORE"\nside="CLIENT"`;
    const captures = [observed('root', 'manifest', forgeRoot), observed('other', 'manifest', forgeOther)];
    const client = solveModCaptures(request('forge', 'root', captures));
    expect(client.selection).toBe('valid');
    expect(client.ordering).toBe('cycle');
    const server = solveModCaptures(request('forge', 'root', captures, 'SERVER'));
    expect(server.selection).toBe('valid');
    expect(server.ordering).toBe('cycle');
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

  test('PKG09: Modrinth and CurseForge retain embedded, optional and required grain', () => {
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

  test('PKG10: inaccessible Nexus range is recorded as incomplete, never empty', () => {
    const outcome = solveModCaptures(request('nexus', 'game/mod/file', [
      observed('game/mod/file', 'graphql-public', { data: { __typename: 'Query',
        games: { nodes: [{ id: 10325 }] } } }),
      { identity: 'game/mod/file', surface: 'file-version-range', status: 'inaccessible',
        bytesBase64: null, sha256: null },
    ]));
    expect(outcome.selection).toBe('incomplete-source-data');
    expect(outcome.coverage.map(item => [item.surface, item.status]))
      .toEqual([['graphql-public', 'observed'], ['file-version-range', 'inaccessible']]);
    expect(outcome.relations).toEqual([]);
  });

  test('PKG11: Steam item dependency is soft; Collection membership is distinct', () => {
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

  test('PKG11: native Collection response creates membership without a hard install edge', () => {
    const collection = solveModCaptures(request('steam', '123', [
      observed('123', 'collection-details', { response: { collectiondetails: [{
        publishedfileid: '123', result: 1, children: [
          { publishedfileid: '456', sortorder: 0, filetype: 0 },
          { publishedfileid: '789', sortorder: 1, filetype: 0 },
        ] }] } }),
    ]));
    expect(collection.selection).toBe('valid');
    expect(collection.relations.map(edge => [edge.to, edge.kind, edge.strength]))
      .toEqual([['456', 'collection-member', 'collection'],
        ['789', 'collection-member', 'collection']]);
    expect(collection.cost.comparisons).toBe(0);
    expect(collection.independentDownloads).toEqual(['123']);
    const missingChildren = solveModCaptures(request('steam', '123', [
      observed('123', 'details-public', { response: { publishedfiledetails: [
        { publishedfileid: '123', result: 1 }] } }),
    ]));
    expect(missingChildren.selection).toBe('incomplete-source-data');
    expect(missingChildren.relations).toEqual([]);
  });

  test('PKG10/PKG11: provider coverage and Collection work stay bounded by captures and children', () => {
    for (const count of [1, 4, 16]) {
      const response = { response: { collectiondetails: [{ publishedfileid: '123', result: 1,
        children: Array.from({ length: count }, (_, index) => ({
          publishedfileid: String(1000 + index), sortorder: index, filetype: 0 })) }] } };
      const outcome = solveModCaptures(request('steam', '123', [
        observed('123', 'collection-details', response)]));
      expect(outcome.selection).toBe('valid');
      expect(outcome.cost.captures).toBe(1);
      expect(outcome.cost.relations).toBe(count);
      expect(outcome.cost.comparisons).toBe(0);
    }
    const nexus = solveModCaptures(request('nexus', '1', [
      observed('1', 'graphql-public', { data: { __typename: 'Query',
        games: { nodes: [{ id: 10325 }] } } }),
      { identity: '1', surface: 'file-version-range', status: 'inaccessible',
        bytesBase64: null, sha256: null },
    ]));
    expect(nexus.cost.captures).toBe(2);
    expect(nexus.cost.relations).toBe(0);
    expect(nexus.cost.comparisons).toBe(0);
  });

  test('PKG09/PKG10: unsupported provider clauses do not become empty dependencies', () => {
    const fileOnly = solveModCaptures(request('modrinth', 'V1', [observed('V1', 'version',
      { id: 'V1', project_id: 'P1', dependencies: [{ project_id: null,
        version_id: null, file_name: 'external.jar', dependency_type: 'required' }] })]));
    expect(fileOnly.selection).toBe('unsupported-semantics');
    const experimental = solveModCaptures(request('nexus', 'game/mod/file', [
      observed('game/mod/file', 'file-version-range', { dependencies: [] })]));
    expect(experimental.selection).toBe('unsupported-semantics');
    expect(experimental.coverage[0]?.status).toBe('observed');
  });

  test('PKG07/PKG08/PKG09/PKG10/PKG11: bad digest and duplicate identities cannot create a solved outcome', () => {
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

  test('PKG07/PKG08/PKG09/PKG10/PKG11: bounded counters grow with captures and relations only', () => {
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
