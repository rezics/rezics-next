import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { preserveReapEnvironment } from './container-reaper.ts';

// Opt-in evidence for loopback browser transport under real stack lifecycle
// churn. This is a separate tiny stack: it never restarts the journey's backend.
const directory = resolve(process.argv[2] ?? '.temp/network-churn');
mkdirSync(directory, { recursive: true });
const image = readFileSync(resolve(import.meta.dir, '../../infra/dev/compose.yaml'), 'utf8')
  .match(/^  mailpit:\n    image: (\S+)/m)?.[1];
if (!image) throw new Error('The pinned QA Mailpit image is missing');
const compose = join(directory, 'compose.yaml');
writeFileSync(compose, `services:\n  mailpit:\n    image: ${image}\n    mem_limit: 128m\n`);
const args = ['compose', '-f', compose, '--project-name', `rezics-qa-network-churn-${process.pid}`];
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; wake?.(); });
async function command(commandArgs: string[]) {
  const child = spawn('docker', [...args, ...commandArgs], { stdio: 'inherit', env: preserveReapEnvironment(process.env) });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? done() : reject(new Error(`Network churn Compose exited ${code}`)));
  });
}
async function pause() {
  await new Promise<void>(done => {
    const timer = setTimeout(() => { wake = undefined; done(); }, 5_000);
    wake = () => { clearTimeout(timer); wake = undefined; done(); };
  });
}
try {
  for (let cycle = 1; !stopping; cycle++) {
    await command(['up', '--detach', '--no-build', '--pull', 'never']);
    console.log(JSON.stringify({ event: 'network_churn_started', cycle, time: new Date().toISOString() }));
    await pause();
    await command(['down', '--timeout', '1']);
    console.log(JSON.stringify({ event: 'network_churn_stopped', cycle, time: new Date().toISOString() }));
    if (!stopping) await pause();
  }
} finally { await command(['down', '--timeout', '1']); }
