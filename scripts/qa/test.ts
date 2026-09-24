import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath } from './acceptance.ts';

const root = resolve(import.meta.dir, '../..');
const testFile = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;

export function selectTestCommand(args: string[]): [string, string[]] {
  const paths = args.filter(arg => testFile.test(arg));
  if (!paths.length) throw new Error('Provide explicit test file paths; full-suite execution belongs to yarn qa.');
  const files = paths.map(path => {
    const absolute = resolve(root, path);
    const local = relative(root, absolute).replaceAll('\\', '/');
    if (local.startsWith('..') || isAbsolute(local) || !existsSync(absolute)) {
      throw new Error(`Test file is outside this checkout or missing: ${path}`);
    }
    return local;
  });
  const integration = files.filter(isQaIntegrationPath);
  const model = files.filter(isQaModelPath);
  const fault = files.filter(isQaFaultPath);
  const load = files.filter(isQaLoadPath);
  const e2e = files.filter(isQaE2ePath);
  if (!integration.length && !model.length && !fault.length && !load.length && !e2e.length) return ['bun', ['test', ...args]];
  if (integration.length + model.length + fault.length + load.length + e2e.length !== files.length
    || [integration, model, fault, load, e2e].filter(group => group.length).length !== 1) {
    throw new Error('Run registered QA integration, model, fault/recovery, load, e2e and other test files in separate commands');
  }
  const other = args.filter(arg => !testFile.test(arg));
  let id: string | undefined;
  if (other.length) {
    if (other.length !== 2 || other[0] !== '-t'
      || !/^[A-Z][A-Z0-9]*\d{2,}$/.test(other[1]!)) {
      throw new Error('QA stack selection accepts only -t <acceptance ID>');
    }
    id = other[1];
  }
  return ['corepack', ['yarn', 'qa', '--tier', model.length ? 'model' : fault.length ? 'fault/recovery' : load.length ? 'load' : e2e.length ? 'e2e' : 'integration',
    ...files.flatMap(file => ['--file', file]), ...(id ? ['--id', id] : [])]];
}

if (import.meta.main) {
  const [program, args] = selectTestCommand(process.argv.slice(2));
  const child = Bun.spawn([program, ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  process.exit(await child.exited);
}
