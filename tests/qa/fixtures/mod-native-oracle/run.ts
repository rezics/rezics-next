/** Reproduce PKG07/08 observations with publisher-checksummed loader JARs. Run from repo root. */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { solveModCaptures, type ModCapture }
  from '../../../../services/main/src/modules/package/mod-profile.ts';

const fixture = import.meta.dir;
const root = join(fixture, '../../../..');
const work = join(root, '.temp/mod-oracle');
const lock = await Bun.file(join(fixture, 'lock.json')).json() as {
  image: string; java: string; dependencyPlugin: string; dependencyPluginSha256: string;
  artifacts: Record<string, { url: string; sha256: string }>;
  libraries: Record<string, Record<string, string>>;
};
const sha = async (path: string): Promise<string> => createHash('sha256')
  .update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest('hex');
const run = async (args: string[], cwd = root): Promise<string> => {
  const process = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
};
const check = (output: string, expected: string): void => {
  if (!output.includes(expected)) throw new Error(`native oracle missing ${expected}\n${output}`);
};
const docker = (directory: string, command: string[]): string[] => [
  'docker', 'run', '--rm', '--network', 'none', '--hostname', 'localhost',
  '-v', `${directory}:/work`, '-w', '/work', lock.image, ...command,
];

await mkdir(work, { recursive: true });
check(await run(['docker', 'run', '--rm', '--network', 'none', '--hostname', 'localhost',
  lock.image, 'java', '-version']), lock.java);
for (const [name, artifact] of Object.entries(lock.artifacts)) {
  const file = join(work, artifact.url.split('/').at(-1)!);
  if (!(await Bun.file(file).exists()) || await sha(file) !== artifact.sha256) {
    const response = await fetch(artifact.url);
    if (!response.ok) throw new Error(`${name} download returned ${response.status}`);
    await Bun.write(file, new Uint8Array(await response.arrayBuffer()));
  }
  const sidecar = await fetch(`${artifact.url}.sha256`);
  if (!sidecar.ok || (await sidecar.text()).trim() !== artifact.sha256
    || await sha(file) !== artifact.sha256) throw new Error(`${name} publisher digest mismatch`);
}
for (const owner of ['forge', 'neo'] as const) {
  const directory = join(work, owner);
  await mkdir(join(directory, 'root/META-INF'), { recursive: true });
  await Bun.write(join(directory, 'pom.xml'), await Bun.file(join(fixture, `${owner}-pom.xml`)).text());
  await Bun.write(join(directory, owner === 'forge' ? 'ForgeOracle.java' : 'NeoOracle.java'),
    await Bun.file(join(fixture, owner === 'forge' ? 'ForgeOracle.java' : 'NeoOracle.java')).text());
  await Bun.write(join(directory, 'root/META-INF',
    owner === 'forge' ? 'mods.toml' : 'neoforge.mods.toml'),
  await Bun.file(join(fixture, owner === 'forge' ? 'forge-mods.toml' : 'neoforge-mods.toml')).text());
  if (owner === 'neo') {
    await mkdir(join(directory, 'other/META-INF'), { recursive: true });
    await Bun.write(join(directory, 'other/META-INF/neoforge.mods.toml'),
      await Bun.file(join(fixture, 'neoforge-other.mods.toml')).text());
  }
  await run(['docker', 'run', '--rm', '-v', `${directory}:/work`, '-w', '/work', lock.image,
    'mvn', '-B', '-q', '-Dmaven.repo.local=/work/.m2',
    `org.apache.maven.plugins:maven-dependency-plugin:${lock.dependencyPlugin}:copy-dependencies`,
    '-DoutputDirectory=/work/lib']);
  const plugin = join(directory, '.m2/org/apache/maven/plugins/maven-dependency-plugin',
    lock.dependencyPlugin, `maven-dependency-plugin-${lock.dependencyPlugin}.jar`);
  if (await sha(plugin) !== lock.dependencyPluginSha256) throw new Error('Maven plugin digest mismatch');
  const actual = (await readdir(join(directory, 'lib'))).filter(name => name.endsWith('.jar')).sort();
  const expected = Object.keys(lock.libraries[owner]!).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${owner} library set changed`);
  for (const name of actual) if (await sha(join(directory, 'lib', name)) !== lock.libraries[owner]![name]) {
    throw new Error(`${owner}/${name} digest mismatch`);
  }
}
await Bun.write(join(work, 'FabricOracle.java'), await Bun.file(join(fixture, 'FabricOracle.java')).text());
await Bun.write(join(work, 'FabricDiscoveryOracle.java'),
  await Bun.file(join(fixture, 'FabricDiscoveryOracle.java')).text());
await run(docker(work, ['javac', '-proc:none', '-cp', 'fabric-loader-0.19.4.jar',
  '-d', '.', 'FabricOracle.java', 'FabricDiscoveryOracle.java']));
const json = async (name: string, value: unknown): Promise<void> => {
  await Bun.write(join(work, name), JSON.stringify(value));
};
await json('root.json', { schemaVersion: 1, id: 'root', version: '1.0.0',
  environment: 'client', depends: { other: '*' } });
await json('other.json', { schemaVersion: 1, id: 'other', version: '1.0.0' });
await json('parent.json', { schemaVersion: 1, id: 'parent', version: '1.0.0',
  jars: [{ file: 'META-INF/jars/child.jar' }], depends: { child: '*' } });
await json('child.json', { schemaVersion: 1, id: 'child', version: '1.0.0' });
await json('side-parent.json', { schemaVersion: 1, id: 'parent', version: '1.0.0',
  depends: { child: '*' } });
await json('side-child.json', { schemaVersion: 1, id: 'child', version: '1.0.0',
  environment: 'client' });
await json('soft.json', { schemaVersion: 1, id: 'soft', version: '1.0.0',
  conflicts: { other: '*' } });
await json('hard.json', { schemaVersion: 1, id: 'hard', version: '1.0.0',
  breaks: { other: '*' } });
const fabric = async (...args: string[]): Promise<string> => run(docker(work,
  ['java', '-cp', '.:fabric-loader-0.19.4.jar', 'FabricOracle', ...args]));
check(await fabric('CLIENT', 'root.json', 'other.json'), 'SELECTED [other, root]');
check(await fabric('SERVER', 'root.json', 'other.json'), 'SELECTED [other]');
check(await fabric('SERVER', 'side-parent.json', 'side-child.json'), 'REJECTED');
check(await fabric('CLIENT', 'soft.json', 'other.json'), 'SELECTED [other, soft]');
check(await fabric('CLIENT', 'hard.json', 'other.json'), 'REJECTED');
check(await fabric('CLIENT', '--nested', 'parent.json', 'child.json'), 'SELECTED [child, parent]');
await json('provider.json', { schemaVersion: 1, id: 'provider', version: '2.1.0',
  provides: ['alias'] });
await json('alias-user.json', { schemaVersion: 1, id: 'alias_user', version: '1.0.0',
  depends: { alias: '*' } });
await json('array-user.json', { schemaVersion: 1, id: 'array_user', version: '1.0.0',
  depends: { provider: ['>=3.0.0', '^2.0.0'] } });
await json('ranged-alias-user.json', { schemaVersion: 1, id: 'alias_user',
  version: '1.0.0', depends: { alias: '[2.0,3.0)' } });
check(await fabric('CLIENT', 'provider.json', 'alias-user.json', 'array-user.json'),
  'SELECTED [alias_user, array_user, provider]');
check(await fabric('CLIENT', 'provider.json', 'ranged-alias-user.json'), 'REJECTED');
const fabricDiscovery = async (...args: string[]): Promise<string> => run(docker(work,
  ['java', '-cp', 'fabric-loader-0.19.4.jar:.:forge/lib/*', 'FabricDiscoveryOracle', ...args]));
const physicalDiscovery = await fabricDiscovery('CLIENT', 'parent.json', 'child.json');
check(physicalDiscovery, 'DISCOVERED [child, java, parent]');
check(physicalDiscovery, 'ARCHIVE child parent=[parent]');
const capture = async (identity: string, surface: string, file: string): Promise<ModCapture> => {
  const bytes = new Uint8Array(await Bun.file(join(work, file)).arrayBuffer());
  return { identity, surface, status: 'observed', bytesBase64: Buffer.from(bytes).toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
};
const physicalOutcome = solveModCaptures({ profile: 'mod-native-capture-v1',
  ecosystem: 'fabric', side: 'CLIENT', root: 'parent', captures: [
    await capture('parent', 'manifest', 'parent.json'),
    { ...await capture('child', 'manifest', 'child.json'), nestedOf: 'parent',
      nestedPath: 'META-INF/jars/child.jar' },
    await capture('parent', 'archive', 'physical-parent.jar'),
  ] });
if (physicalOutcome.selection !== 'valid'
  || JSON.stringify(physicalOutcome.independentDownloads) !== '["parent"]') {
  throw new Error(`Fabric physical archive comparison failed: ${JSON.stringify(physicalOutcome)}`);
}
check(await fabricDiscovery('CLIENT', 'parent.json', 'child.json', 'other.jar'),
  'DISCOVERED [java, parent]');
await json('client-child.json', { schemaVersion: 1, id: 'child', version: '1.0.0',
  environment: 'client' });
check(await fabricDiscovery('SERVER', 'parent.json', 'client-child.json'),
  'DISCOVERED [java, parent]');
const forge = join(work, 'forge');
await run(docker(forge, ['javac', '-proc:none', '-cp', 'lib/*', 'ForgeOracle.java']));
const forgeOutput = await run(docker(forge,
  ['java', '-cp', '.:lib/*', 'ForgeOracle', 'root']));
for (const expected of ['CLIENT_SIDE_ONLY true', 'FEATURE_CLIENT_3_1 false',
  'FEATURE_SERVER_3_1 true', 'DEPENDENCY other CLIENT BEFORE true [2.0,3.0)']) {
  check(forgeOutput, expected);
}
const modToml = (id: string, version: string, loader: string, extra = ''): string =>
  `modLoader="javafml"\nloaderVersion="[${loader},)"\nlicense="MIT"\n[[mods]]\nmodId="${id}"\nversion="${version}"\n${extra}`;
const writeMod = async (owner: 'forge' | 'neo', id: string, content: string): Promise<void> => {
  const directory = join(work, owner, id, 'META-INF');
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, owner === 'forge' ? 'mods.toml' : 'neoforge.mods.toml'), content);
};
for (const id of ['minecraft', 'forge']) await writeMod('forge', id, modToml(id, '1.0.0', '52'));
await writeMod('forge', 'other', modToml('other', '2.1.0', '52'));
await Bun.write(join(forge, 'ForgeSortOracle.java'),
  await Bun.file(join(fixture, 'ForgeSortOracle.java')).text());
await run(docker(forge, ['javac', '-proc:none', '-cp', 'lib/*', 'ForgeSortOracle.java']));
const forgeSort = async (side: string): Promise<string> => run(docker(forge,
  ['java', '-cp', '.:lib/*', 'ForgeSortOracle', side, 'minecraft', 'forge', 'root', 'other']));
check(await forgeSort('CLIENT'), 'SORTED [minecraft, forge, root, other]');
check(await forgeSort('CLIENT'), 'ERRORS 0');
check(await forgeSort('DEDICATED_SERVER'), 'ERRORS 0');
await writeMod('forge', 'other', modToml('other', '2.1.0', '52',
  '[[dependencies.other]]\nmodId="root"\nmandatory=true\nversionRange="[1.0,2.0)"\nordering="BEFORE"\nside="CLIENT"\n'));
check(await forgeSort('CLIENT'), 'CYCLE_FAILURE NullPointerException sortedList');
check(await forgeSort('DEDICATED_SERVER'), 'CYCLE_FAILURE NullPointerException sortedList');
const neo = join(work, 'neo');
await run(docker(neo, ['javac', '-proc:none', '-cp', 'lib/*', 'NeoOracle.java']));
const neoOutput = await run(docker(neo,
  ['java', '-cp', '.:lib/*', 'NeoOracle', 'root', 'other']));
for (const expected of ['FEATURE_CLIENT_3_1 false', 'FEATURE_SERVER_3_1 true',
  'DEPENDENCY other SERVER AFTER OPTIONAL [2.0,3.0)',
  'MIXIN root.mixins.json [other]', 'MIXIN_WITHOUT_REQUIRED_MOD false',
  'MIXIN_WITH_REQUIRED_MOD true']) check(neoOutput, expected);
for (const id of ['minecraft', 'neoforge']) await writeMod('neo', id, modToml(id, '1.0.0', '4'));
await Bun.write(join(neo, 'NeoSortOracle.java'),
  await Bun.file(join(fixture, 'NeoSortOracle.java')).text());
await run(docker(neo, ['javac', '-proc:none', '-cp', 'lib/*', 'NeoSortOracle.java']));
const neoSort = async (side: string): Promise<string> => run(docker(neo,
  ['java', '-cp', '.:lib/*', 'NeoSortOracle', side, 'minecraft', 'neoforge', 'root', 'other']));
check(await neoSort('CLIENT'), 'ERRORS false');
check(await neoSort('DEDICATED_SERVER'), 'SORTED [minecraft, other, root, neoforge]');
await writeMod('neo', 'other', modToml('other', '2.1.0', '4',
  '[[dependencies.other]]\nmodId="root"\ntype="required"\nversionRange="[1.0,2.0)"\nordering="AFTER"\nside="SERVER"\n'));
check(await neoSort('DEDICATED_SERVER'), 'CYCLE_FAILURE ClassCastException ModInfo');
check(await neoSort('CLIENT'), 'CYCLE_FAILURE ClassCastException ModInfo');
for (const source of ['NeoMixinOracle.java', 'NeoTarget.java', 'NeoTargetMixin.java']) {
  await Bun.write(join(neo, source), await Bun.file(join(fixture, source)).text());
}
await Bun.write(join(neo, 'root/root.mixins.json'),
  await Bun.file(join(fixture, 'root.mixins.json')).text());
await run(docker(neo, ['javac', '-proc:none', '-cp', 'lib/*', '-d', '.',
  'NeoMixinOracle.java', 'NeoTarget.java', 'NeoTargetMixin.java']));
const mixin = async (required: 'present' | 'absent'): Promise<string> => run(docker(neo,
  ['java', '-cp', '.:lib/*', 'NeoMixinOracle', required]));
const applied = await mixin('present');
check(applied, 'REGISTERED [root.mixins.json]');
check(applied, 'TRANSFORMED COMPUTE_FRAMES');
check(applied, 'MIXIN_RESULT mixed');
const skipped = await mixin('absent');
check(skipped, 'REGISTERED []');
check(skipped, 'TRANSFORMED NO_REWRITE');
check(skipped, 'MIXIN_RESULT base');
console.log('PKG07/PKG08 native Fabric, Forge and NeoForge oracle observations passed');
