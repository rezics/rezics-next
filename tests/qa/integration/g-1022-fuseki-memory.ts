import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectName } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { qaResourceHeapBytes, type QaResourceClass } from '../../../scripts/qa/resource-classes.ts';

/** Test-only JDK attach diagnostics. No application health endpoint or runtime
 * instrumentation; attach uses the pinned build JDK in the QA PID namespace. */
export async function fusekiMemoryProbe(resourceClass: QaResourceClass) {
  const env = loadDockerEnvironment();
  const run = async (args: string[]) => {
    const child = Bun.spawn(['docker', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [out, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (await child.exited !== 0) throw new Error(`JDK memory diagnostics failed: ${error}`);
    return out;
  };
  const project = projectName({ profile: 'qa', runId: Bun.env.REZICS_QA_RUN_ID! });
  const container = (await run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=fuseki'])).trim();
  if (!container) throw new Error('QA Fuseki container is unavailable');
  const pid = (await run(['exec', container, 'sh', '-ec',
    'for task in /proc/[0-9]*/comm; do if [ "$(cat "$task")" = java ]; then value=${task#/proc/}; echo ${value%/comm}; break; fi; done'])).trim();
  if (!/^\d+$/.test(pid)) throw new Error('QA Fuseki JVM is unavailable');
  const image = readFileSync(resolve(import.meta.dir, '../../../infra/jena/Dockerfile'), 'utf8')
    .match(/^FROM (maven:\S+) AS module$/m)![1]!;
  const jcmd = (command: string) => run(['run', '--rm', '--pid', `container:${container}`,
    '--user', '10001:10001', '-e', 'JAVA_TOOL_OPTIONS=-Xms16m -Xmx64m', image, 'jcmd', pid, command]);
  const flags = await jcmd('VM.flags');
  const heapMax = Number(flags.match(/-XX:MaxHeapSize=(\d+)/)?.[1]);
  const expectedHeap = qaResourceHeapBytes(resourceClass);
  if (heapMax !== expectedHeap)
    throw new Error(`QA Fuseki ${resourceClass} heap: ${heapMax} bytes, expected ${expectedHeap}`);
  return async (collect = false) => {
    if (collect) await jcmd('GC.run');
    const info = await jcmd('GC.heap_info');
    const heap = info.match(/heap\s+total (\d+)K, used (\d+)K/);
    if (!heap) throw new Error(`Unexpected JVM heap diagnostic: ${info}`);
    const cgroup = (await run(['exec', container, 'sh', '-ec',
      'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max'])).trim().split('\n').map(Number);
    return { heapMax, heapUsed: Number(heap[2]) * 1024, heapCommitted: Number(heap[1]) * 1024,
      containerBytes: cgroup[0]!, containerLimit: cgroup[1]! };
  };
}
