import { randomUUID } from 'node:crypto';
import { buildSearchImage, cgroupArgs, waitForSearch } from '../../../../services/kernel/scripts/search.ts';
import { currentNativeLifecycle } from './lifecycle.ts';

function docker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args]);
  if (result.exitCode !== 0) throw new Error(`Native Web Search setup failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

export async function prepareNativeWebSearch(fixture: string): Promise<{ container?: string }> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Native Web Search setup requires an active native test lifecycle');
  lifecycle.assertOpen('prepare native Web Search');
  if (process.env.OPENSEARCH_URL) return {};

  const container = `native-${fixture}-search-${randomUUID().slice(0, 12)}`;
  const priorUrl = process.env.OPENSEARCH_URL;
  let stopped = false;
  const restore = async () => {
    if (stopped) return;
    stopped = true;
    try {
      docker(['rm', '-fv', container]);
    } finally {
      if (priorUrl === undefined) delete process.env.OPENSEARCH_URL;
      else process.env.OPENSEARCH_URL = priorUrl;
    }
  };

  docker([
    'run',
    '-d',
    ...cgroupArgs(),
    '--name',
    container,
    '-p',
    '127.0.0.1::9200',
    '--tmpfs',
    '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
    '-e',
    'discovery.type=single-node',
    '-e',
    'DISABLE_SECURITY_PLUGIN=true',
    '-e',
    'DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e',
    'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
    buildSearchImage(),
  ]);
  lifecycle.register({ label: `native ${fixture} Search container`, close: restore, force: restore });
  try {
    const address = docker(['port', container, '9200/tcp']).split('\n')[0];
    if (!address) throw new Error('Native Web Search setup returned no published port');
    process.env.OPENSEARCH_URL = `http://${address}`;
    await waitForSearch(process.env.OPENSEARCH_URL, container);
    return { container };
  } catch (error) {
    await restore();
    throw error;
  }
}
