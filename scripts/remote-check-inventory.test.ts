import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dependencyPreparationProgram } from './remote-check.ts';

test('postinstall inventory reuses hashes, invalidates actual mutation and preserves full/native manifests', () => {
  const temporary = resolve(import.meta.dir, '../.temp');
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'preparation-inventory-'));
  try {
    const probe = String.raw`
import json, os, sys, time
from pathlib import Path
namespace = {}
source = sys.stdin.read().split('attempt_started = time.monotonic()', 1)[0]
exec(source, namespace)
root = Path(sys.argv[1])
package = root / 'node_modules/workerd'
(package / 'bin').mkdir(parents=True)
(package / 'package.json').write_text('{"name":"workerd","version":"1.20261114.0"}')
binary = package / 'bin/workerd'
binary.write_bytes(b'alpha')
binary.chmod(0o755)
(root / 'ordinary.txt').write_text('ordinary input')
(root / 'node_modules/workerd-alias').symlink_to('workerd')
original_digest = namespace['digest']
calls = []
def counted(path):
    calls.append(str(path))
    return original_digest(path)
namespace['digest'] = counted
memo = {}
first = namespace['inventory'](root, digest_cache=memo)
first_calls = len(calls)
unchanged = namespace['inventory'](root, digest_cache=memo)
unchanged_calls = len(calls)
before = binary.stat()
time.sleep(0.01)
binary.write_bytes(b'bravo')
os.utime(binary, ns=(before.st_atime_ns, before.st_mtime_ns))
changed = namespace['inventory'](root, digest_cache=memo)
changed_calls = len(calls)
fresh = namespace['inventory'](root)
print(json.dumps({
  'firstCalls': first_calls, 'unchangedCalls': unchanged_calls, 'changedCalls': changed_calls,
  'unchangedEqual': first == unchanged,
  'changedHash': first['node_modules/workerd/bin/workerd'][2] != changed['node_modules/workerd/bin/workerd'][2],
  'sameInodeSizeMtime': before.st_ino == binary.stat().st_ino and before.st_size == binary.stat().st_size and before.st_mtime_ns == binary.stat().st_mtime_ns,
  'fullParity': changed == fresh,
  'nativeParity': namespace['native_entries'](root, changed) == namespace['native_entries'](root, fresh),
  'link': changed['node_modules/workerd-alias'], 'mode': changed['node_modules/workerd/bin/workerd'][1]
}))
`;
    const result = spawnSync('python3', ['-c', probe, root], { input: dependencyPreparationProgram, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      firstCalls: 3, unchangedCalls: 3, changedCalls: 4, unchangedEqual: true, changedHash: true,
      sameInodeSizeMtime: true, fullParity: true, nativeParity: true,
      link: ['link', 'workerd'], mode: 0o755,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
