import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Telemetry's SDK and pg hooks live for one process. A preceding QA file may
 * have loaded pg or shut the SDK down, so native profiles need a fresh process
 * while retaining the shard's graph, owner history and exact assertions. */
export async function queryProfileProcess(file: string, env: Record<string, string> = {}) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR)
    throw new Error('Run through goalctl test');
  const child = Bun.spawn([process.execPath, 'test', `./tests/qa/integration/${file}`], {
    env: { ...process.env, ...env, G1053_QUERY_CHILD: file },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const remainingMs = Number(env.G1053_PROFILE_DEADLINE ?? Date.now() + 440_000) - Date.now();
  const timer = setTimeout(() => child.kill(), Math.max(1, remainingMs));
  let result: [number, string, string];
  try {
    result = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const [code, output, errors] = result;
  const directory = env.REZICS_QA_ARTIFACT_DIR ?? Bun.env.REZICS_QA_ARTIFACT_DIR;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${file}.log`), `${output}\n${errors}`);
  if (code !== 0)
    throw new Error(`Query profile ${file} failed (${code}):\n${errors.slice(-6000)}`);
}
