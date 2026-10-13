import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildOperationIndex } from '../../api/operation-index.ts';
import { formatProbeAnswer, parseProbeCalls, probeRecord, probeRecordPath, type ProbeResult } from '../persona.ts';

export const usage = "Usage: goalctl persona '<persona> <METHOD> <path> [json body]' ... [--private] [--full] [--record <file>]";

export default async function persona(args: string[]): Promise<number> {
  const root = resolve(import.meta.dir, '../../..');
  const calls: string[] = [];
  let visibility: 'public' | 'private' = 'public';
  let full = false;
  let record: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--private') visibility = 'private';
    else if (arg === '--full') full = true;
    else if (arg === '--record') {
      const file = args[++index];
      if (!file || file.startsWith('--')) throw new Error('--record needs a repository file');
      record = probeRecordPath(root, file);
    } else if (arg.startsWith('--')) throw new Error(usage);
    else calls.push(arg);
  }
  const validated = parseProbeCalls(calls, await buildOperationIndex(root));
  const temporary = join(root, '.temp/persona');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'probe-'));
  const input = join(directory, 'calls.json');
  const output = join(directory, 'answers.json');
  const qaResult = join(directory, 'qa-result.json');
  writeFileSync(input, JSON.stringify({ visibility, calls: validated }), { mode: 0o600 });
  try {
    // Raw application/runner output never becomes a probe transcript.
    const child = Bun.spawn([process.execPath, 'scripts/goal/goalctl.ts', 'test',
      'tests/qa/integration/persona-probe.test.ts', '--result-file', qaResult], {
      cwd: root, env: { ...process.env, REZICS_PERSONA_PROBE_INPUT: input, REZICS_PERSONA_PROBE_OUTPUT: output },
      stdout: 'ignore', stderr: 'ignore',
    });
    const code = await child.exited;
    let result: ProbeResult;
    try { result = JSON.parse(readFileSync(output, 'utf8')) as ProbeResult; }
    catch { throw new Error(`Persona QA run failed (${code}); runner result: ${qaResult}`); }
    console.log(`Persona setup: ${result.visibility} ${result.setupSeconds.toFixed(3)}s`);
    for (const call of result.calls) console.log(formatProbeAnswer(call, full));
    console.log(`QA result: ${qaResult}`);
    if (code !== 0 || result.error) throw new Error(result.error ?? `Persona QA run failed (${code})`);
    if (record) {
      probeRecordPath(root, record);
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, `${JSON.stringify(probeRecord(result), null, 2)}\n`, { mode: 0o600 });
    }
    return 0;
  } finally {
    rmSync(input, { force: true });
    rmSync(output, { force: true });
  }
}
