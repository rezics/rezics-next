import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activateBackend, backendCommand, rebaseBackendDependencyLinks } from './refresh.ts';
import { prepareComponent } from '../../services/main/src/modules/work/activate.ts';
import { storeExactBytes } from '../../services/main/src/modules/web-publication/bytes.ts';
import type { WorkActivationEnvironment } from '../../services/main/src/modules/work/activate.ts';

const directories: string[] = [];
function fixture() {
  mkdirSync('.temp', { recursive: true });
  const directory = resolve(mkdtempSync('.temp/windows-bootstrap-'));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('a frozen backend can be started twice and switched to another revision', () => {
  const root = fixture();
  const stack = join(root, 'stack'), first = join(root, 'first'), second = join(root, 'second');
  for (const path of [stack, first, second]) mkdirSync(path);
  activateBackend(stack, first);
  activateBackend(stack, first);
  activateBackend(stack, second);
  expect(realpathSync(join(stack, 'backend'))).toBe(realpathSync(second));
  expect(existsSync(join(stack, 'backend.tmp'))).toBe(false);
});

for (const copiedAsDirectory of [false, true]) test(`frozen workspace imports survive source changes (copied directory: ${copiedAsDirectory})`, () => {
  const root = fixture(), source = join(root, 'source'), checkout = join(root, 'checkout');
  for (const path of [source, checkout]) {
    mkdirSync(join(path, 'packages/entry'), { recursive: true });
    mkdirSync(join(path, 'node_modules/@fixture'), { recursive: true });
    writeFileSync(join(path, 'packages/entry/package.json'), JSON.stringify({ name: '@fixture/entry' }));
    writeFileSync(join(path, 'packages/entry/value'), 'frozen');
  }
  symlinkSync(join(source, 'packages/entry'), join(source, 'node_modules/@fixture/entry'), 'junction');
  const copied = join(checkout, 'node_modules/@fixture/entry');
  if (copiedAsDirectory) { mkdirSync(copied); writeFileSync(join(copied, 'value'), 'copied source'); }
  else symlinkSync(join(source, 'packages/entry'), copied, 'junction');
  rebaseBackendDependencyLinks(source, checkout, ['node_modules'], ['packages/entry/package.json']);
  writeFileSync(join(source, 'packages/entry/value'), 'changed source');
  expect(readFileSync(join(copied, 'value'), 'utf8')).toBe('frozen');
});

test('local immutable component and publication bytes retain verified, synchronized content', async () => {
  const root = fixture();
  const manifest = prepareComponent(join(root, 'components'), 'urn:local:test', { title: '本机验收' });
  const stored = JSON.parse(readFileSync(join(root, 'components', manifest), 'utf8'));
  const payload = JSON.parse(readFileSync(join(root, 'components', stored.payload.slice('sha256:'.length)), 'utf8'));
  expect(payload.state.title).toBe('本机验收');
  const environment = { objectDirectory: join(root, 'publication') } as WorkActivationEnvironment;
  const bytes = Buffer.from('Published content');
  const digest = await storeExactBytes(environment, bytes);
  expect(readFileSync(join(environment.objectDirectory, digest))).toEqual(bytes);
  writeFileSync(join(environment.objectDirectory, digest), 'corrupt');
  await expect(storeExactBytes(environment, bytes)).rejects.toThrow('snapshot object is corrupt');
});

(process.platform === 'win32' ? test : test.skip)('native Windows dependency copies admit Robocopy success codes', () => {
  const root = fixture(), source = join(root, 'source'), target = join(root, 'target');
  mkdirSync(source);
  writeFileSync(join(source, 'value'), 'dependency');
  backendCommand(root, 'robocopy', [source, target, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS']);
  expect(readFileSync(join(target, 'value'), 'utf8')).toBe('dependency');
});
