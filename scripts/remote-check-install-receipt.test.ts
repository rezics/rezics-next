import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  dependencyPreparationProgram,
  installReceiptContractPython,
  preparedInputEvidenceProgram,
} from './remote-check.ts';

const repository = resolve(import.meta.dir, '..');
const host = 'receipt-check';
const run = 'receipt-fixture';
const source = 'a'.repeat(64);
const roots: string[] = [];
const writer = `${installReceiptContractPython}
import json,sys
from pathlib import Path
arguments=json.loads(sys.stdin.read())
receipt=make_install_receipt(**arguments)
Path(sys.argv[1]).write_text(json.dumps(receipt,sort_keys=True))
`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeOwned(root: string, path: string, contents: string): void {
  writeFileSync(join(root, path), contents);
  chmodSync(join(root, path), 0o644);
}

function fixture(telemetry: Record<string, unknown> = {}, cache = 'hit') {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repository, '.temp', 'install-receipt-'));
  roots.push(root);
  writeOwned(root, 'source.ts', 'export const source = true;\n');
  writeOwned(root, '.alive', '');
  writeOwned(root, '.bun-install-complete', '');
  writeOwned(root, '.remote-check-slot-count', '1\n');
  writeOwned(
    root,
    '.remote-check-supervisor',
    JSON.stringify({
      schema: 1,
      host,
      run,
      pid: process.pid,
      started: '123',
      group: process.pid,
      uid: process.getuid?.() ?? 0,
    }),
  );
  writeOwned(
    root,
    '.preparation-started',
    JSON.stringify({ schema: 1, host, run, deadline: 123.456, limitMs: 900_000 }),
  );
  const written = spawnSync('python3', ['-c', writer, join(root, 'preparation-install.json')], {
    input: JSON.stringify({
      host,
      run,
      cache,
      native_cache: cache === 'hit' ? null : 'miss',
      key: 'c'.repeat(64),
      packages: [],
      native_checks: [],
      ...telemetry,
    }),
    encoding: 'utf8',
    timeout: 5_000,
  });
  expect(written.status, written.stderr).toBe(0);
  chmodSync(join(root, 'preparation-install.json'), 0o644);
  return root;
}

function verify(root: string, label = 'evidence') {
  const receiptRoot = join(root, '.temp', label);
  const result = spawnSync('python3', ['-c', preparedInputEvidenceProgram, root, run, host, source, receiptRoot], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return { result, path: join(receiptRoot, run, 'prepared-inputs.json') };
}

test('the actual dependency writer and prepared-input reader embed one receipt contract', () => {
  expect(dependencyPreparationProgram).toContain(installReceiptContractPython);
  expect(dependencyPreparationProgram).toContain('receipt = make_install_receipt(');
  expect(preparedInputEvidenceProgram).toContain(installReceiptContractPython);
});

test.each([
  { name: 'legacy cache hit', cache: 'hit', telemetry: {} },
  { name: 'legacy cache miss', cache: 'miss', telemetry: {} },
  {
    name: 'current cache hit with no installer',
    cache: 'hit',
    telemetry: {
      installer_seconds: null,
      phase_seconds: { 'artifact-restore': 6.197, 'host-pressure-wait-io': 304.428 },
    },
  },
  {
    name: 'timed cache miss',
    cache: 'miss',
    telemetry: {
      installer_seconds: 18.5,
      phase_seconds: { 'frozen-install': 18.5, 'source-artifact-publication': 0.125 },
    },
  },
  { name: 'empty timing map', cache: 'hit', telemetry: { installer_seconds: null, phase_seconds: {} } },
  { name: 'optional installer duration only', cache: 'miss', telemetry: { installer_seconds: 0 } },
  { name: 'optional phases only', cache: 'hit', telemetry: { phase_seconds: {} } },
  {
    name: 'exact preparation horizon',
    cache: 'miss',
    telemetry: { installer_seconds: 900, phase_seconds: { 'frozen-install': 900 } },
  },
  {
    name: '64 bounded phases and a 64-character phase name',
    cache: 'hit',
    telemetry: {
      phase_seconds: {
        ...Object.fromEntries(
          Array.from({ length: 63 }, (_, index) => [
            `phase-${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
            0,
          ]),
        ),
        ['a'.repeat(64)]: 0,
      },
    },
  },
])('actual Python writer/reader accepts $name', ({ telemetry, cache }) => {
  const root = fixture(telemetry, cache);
  const { result, path } = verify(root);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    schema: 1,
    host,
    run,
    sourceSha256: source,
    fileCount: 1,
  });
});

type InvalidReceipt = {
  name: string;
  patch: Record<string, unknown>;
  literal?: string;
  reason: string;
};
const malformed: InvalidReceipt[] = [
  { name: 'unknown top-level field', patch: { unknownTiming: 1 }, reason: 'invalid shape' },
  { name: 'foreign host', patch: { host: 'foreign-host' }, reason: 'identity is foreign or malformed' },
  { name: 'foreign run', patch: { run: 'foreign-run' }, reason: 'identity is foreign or malformed' },
  { name: 'invalid package list', patch: { packages: {} }, reason: 'identity is foreign or malformed' },
  { name: 'invalid native checks', patch: { nativeChecks: {} }, reason: 'identity is foreign or malformed' },
  { name: 'invalid cache key', patch: { key: 'foreign' }, reason: 'identity is foreign or malformed' },
  { name: 'null phase map', patch: { phaseSeconds: null }, reason: 'timing is malformed' },
  { name: 'array phase map', patch: { phaseSeconds: [] }, reason: 'timing is malformed' },
  {
    name: 'too many phases',
    patch: {
      phaseSeconds: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `phase-${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
          0,
        ]),
      ),
    },
    reason: 'timing is malformed',
  },
  { name: 'oversized phase name', patch: { phaseSeconds: { ['a'.repeat(65)]: 0 } }, reason: 'timing is malformed' },
  { name: 'malformed phase name', patch: { phaseSeconds: { 'phase/name': 0 } }, reason: 'timing is malformed' },
  { name: 'negative installer', patch: { installerSeconds: -1 }, reason: 'timing is malformed' },
  { name: 'boolean installer', patch: { installerSeconds: true }, reason: 'timing is malformed' },
  { name: 'string installer', patch: { installerSeconds: '1' }, reason: 'timing is malformed' },
  { name: 'installer beyond preparation horizon', patch: { installerSeconds: 900.001 }, reason: 'timing is malformed' },
  { name: 'NaN installer', patch: { installerSeconds: '__NUMBER__' }, literal: 'NaN', reason: 'timing is malformed' },
  {
    name: 'infinite installer',
    patch: { installerSeconds: '__NUMBER__' },
    literal: 'Infinity',
    reason: 'timing is malformed',
  },
  {
    name: 'huge integer installer',
    patch: { installerSeconds: '__NUMBER__' },
    literal: '9'.repeat(400),
    reason: 'timing is malformed',
  },
  { name: 'negative phase', patch: { phaseSeconds: { 'artifact-restore': -1 } }, reason: 'timing is malformed' },
  { name: 'null phase', patch: { phaseSeconds: { 'artifact-restore': null } }, reason: 'timing is malformed' },
  { name: 'boolean phase', patch: { phaseSeconds: { 'artifact-restore': false } }, reason: 'timing is malformed' },
  {
    name: 'phase beyond preparation horizon',
    patch: { phaseSeconds: { 'artifact-restore': 900.001 } },
    reason: 'timing is malformed',
  },
  {
    name: 'NaN phase',
    patch: { phaseSeconds: { 'artifact-restore': '__NUMBER__' } },
    literal: 'NaN',
    reason: 'timing is malformed',
  },
  {
    name: 'infinite phase',
    patch: { phaseSeconds: { 'artifact-restore': '__NUMBER__' } },
    literal: 'Infinity',
    reason: 'timing is malformed',
  },
  { name: 'oversized receipt', patch: { phaseSeconds: { ['a'.repeat(262144)]: 0 } }, reason: 'invalid file identity' },
];

test.each(malformed)(
  'actual Python verifier rejects $name before publishing prepared evidence',
  ({ patch, literal, reason }) => {
    const root = fixture();
    const receipt = { ...JSON.parse(readFileSync(join(root, 'preparation-install.json'), 'utf8')), ...patch };
    let contents = JSON.stringify(receipt);
    if (literal) contents = contents.replace('"__NUMBER__"', literal);
    writeOwned(root, 'preparation-install.json', contents);
    const { result, path } = verify(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(reason);
    expect(existsSync(path)).toBe(false);
  },
);

test('optional telemetry never changes prepared-source evidence and cannot replace required identity', () => {
  const root = fixture();
  const legacy = verify(root, 'legacy');
  expect(legacy.result.status, legacy.result.stderr).toBe(0);
  const initial = JSON.parse(readFileSync(legacy.path, 'utf8'));
  const receipt = JSON.parse(readFileSync(join(root, 'preparation-install.json'), 'utf8'));
  writeOwned(
    root,
    'preparation-install.json',
    JSON.stringify({ ...receipt, installerSeconds: null, phaseSeconds: {} }),
  );
  const current = verify(root, 'current');
  expect(current.result.status, current.result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(current.path, 'utf8'))).toEqual(initial);
  delete receipt.nativeChecks;
  writeOwned(root, 'preparation-install.json', JSON.stringify(receipt));
  const invalid = verify(root, 'missing-identity');
  expect(invalid.result.status).not.toBe(0);
  expect(invalid.result.stderr).toContain('invalid shape');
  expect(existsSync(invalid.path)).toBe(false);
});


test('host pressure gate partitions observed wait reasons and its unchanged v1 receipt reaches the real consumer', () => {
  const root = fixture();
  const program = String.raw`import ast,json,sys
from pathlib import Path
from types import SimpleNamespace
source=json.loads(sys.stdin.read())
module=ast.parse(source)
names={'record_preparation_pressure_wait','preparation_io_gate','preparation_progress','preparation_phase_seconds'}
functions=[node for node in module.body if isinstance(node,ast.FunctionDef) and node.name in names]
assert len(functions)==len(names)
clock=[0.0]
def sleep(elapsed): clock[0]+=elapsed
observations=iter([
    (True,False,{'ioFull':11,'memoryFull':0}),
    (True,False,{'ioFull':0,'memoryFull':2}),
    (True,False,{'ioFull':11,'memoryFull':2}),
    (True,False,{'ioFull':0.1,'memoryFull':0}),
    (True,False,None),
    (False,False,{'ioFull':0.1,'memoryFull':0}),
])
ns={'Path':Path,'json':json,'time':SimpleNamespace(monotonic=lambda:clock[0],sleep=sleep),
    'os':SimpleNamespace(environ={'REMOTE_CHECK_PREPARATION_DEADLINE':'30',
        'REMOTE_CHECK_PREPARATION_CACHE':str(Path(sys.argv[1])/'cache')}),
    'update_host_pressure':lambda _:next(observations),
    'PREPARATION_IO_ROOT':Path(sys.argv[1]),'PREPARATION_IO_NEXT':0,
    'PREPARATION_IO_PHASE':None,'PREPARATION_PHASE_AT':None,
    'PREPARATION_PHASE_SECONDS':{},'PREPARATION_PRESSURE_SECONDS':{}}
exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-preparation-functions','exec'),ns)
ns['preparation_progress'](Path(sys.argv[1]),'artifact-restore')
ns['preparation_io_gate']()
phases=ns['preparation_phase_seconds']()
assert ns['PREPARATION_IO_PHASE']=='artifact-restore'
assert ns['PREPARATION_IO_NEXT']==2.75
print(json.dumps(phases))
`;
  const measured = spawnSync('python3', ['-c', program, root], {
    input: JSON.stringify(dependencyPreparationProgram), encoding: 'utf8', timeout: 5000,
  });
  expect(measured.status, measured.stderr).toBe(0);
  const phases = JSON.parse(measured.stdout);
  expect(phases).toEqual({
    'artifact-restore': 0,
    'host-pressure-wait-io': 0.5,
    'host-pressure-wait-memory': 0.5,
    'host-pressure-wait-io-memory': 0.5,
    'host-pressure-wait-recovery-hold': 0.5,
    'host-pressure-wait-state-lock': 0.5,
  });
  expect(Object.values(phases).reduce((sum: number, value) => sum + Number(value), 0)).toBe(2.5);
  expect(phases).not.toHaveProperty('host-pressure-wait');
  expect(phases).not.toHaveProperty('cache-io-pressure-wait');
  const written = fixture({ installer_seconds: null, phase_seconds: phases });
  const receipt = JSON.parse(readFileSync(join(written, 'preparation-install.json'), 'utf8'));
  expect(Object.keys(receipt)).toHaveLength(10);
  const consumed = verify(written);
  expect(consumed.result.status, consumed.result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(consumed.path, 'utf8'))).toMatchObject({ sourceSha256: source, fileCount: 1 });
});
