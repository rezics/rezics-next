import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { inspectNativeProcess, NativeTestLifecycle } from './lifecycle.ts';
import { launchPrivateBrowser } from './private-browser.ts';

function report(name: string, value: unknown): void {
  process.stdout.write(`${name} ${JSON.stringify(value)}\n`);
}

async function firstLine(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error(`Resistant child handshake exceeded ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      if (error) reject(error);
      else resolve(line ?? '');
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(undefined, buffer.slice(0, newline));
    };
    child.stdout?.on('data', onData);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Resistant child exited before its handshake (${code})`)));
  });
}

async function deadlineFailure(): Promise<void> {
  const lifecycle = new NativeTestLifecycle('controlled native deadline injection', undefined, {
    cleanupGraceMs: 300,
    forceGraceMs: 800,
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let listenerPort: number | undefined;
  let privateBrowser: Awaited<ReturnType<typeof launchPrivateBrowser>> | undefined;
  let devServer: ReturnType<typeof spawn> | undefined;
  let devServerIdentity: ReturnType<typeof inspectNativeProcess>;
  let devServerPort: number | undefined;
  let resistantGroup: ReturnType<typeof spawn> | undefined;
  let resistantLeader: ReturnType<typeof inspectNativeProcess>;
  let resistantDescendant: ReturnType<typeof inspectNativeProcess>;
  let browserNetworkNamespace: string | undefined;
  let pageVisited = false;
  let receivedTimeout = false;

  await lifecycle.run(
    'prepare controlled native failure fixture',
    20_000,
    async () => {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () =>
          new Response('<main>owned native lifecycle page</main>', { headers: { 'content-type': 'text/html' } }),
      });
      listenerPort = server.port;
      const ownedServer = server;
      lifecycle.register({
        label: 'hung owned native listener',
        close: () => new Promise<void>(() => {}),
        force: () => ownedServer.stop(true),
      });

      const devServerCode = [
        "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<main>owned native lifecycle page</main>', { headers: { 'content-type': 'text/html' } }) });",
        'console.log(JSON.stringify({ port: server.port }));',
        "process.on('SIGTERM', () => server.stop(true));",
        'setInterval(() => {}, 1000);',
      ].join('');
      devServer = spawn(process.execPath, ['-e', devServerCode], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const devServerOwner = lifecycle.ownProcessGroup('owned native dev server', devServer);
      const ready = JSON.parse(await firstLine(devServer, 3_000)) as { port: number };
      devServerPort = ready.port;
      devServerIdentity = devServerOwner.identity;

      const resistantCode = [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid) + '\\n');",
        'setInterval(() => {}, 1000);',
      ].join('');
      resistantGroup = spawn('node', ['-e', resistantCode], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      lifecycle.ownProcessGroup('TERM-resistant native child group', resistantGroup);
      const descendantPid = Number(await firstLine(resistantGroup, 3_000));
      resistantLeader = inspectNativeProcess(resistantGroup.pid!);
      resistantDescendant = inspectNativeProcess(descendantPid);
      if (!resistantLeader || !resistantDescendant || resistantLeader.pgid !== resistantDescendant.pgid)
        throw new Error('Resistant native child did not inherit its owned process group');

      privateBrowser = await launchPrivateBrowser([`http://127.0.0.1:${devServerPort}`]);
      browserNetworkNamespace = readlinkSync(`/proc/${privateBrowser.processIdentity.pid}/ns/net`);
      if (browserNetworkNamespace === readlinkSync('/proc/self/ns/net'))
        throw new Error('Native browser did not enter its private network namespace');
      const page = await privateBrowser.browser.newPage();
      const browserDiagnostics: string[] = [];
      page.on('requestfailed', (request) => {
        browserDiagnostics.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
      });
      lifecycle.register({
        label: 'owned lifecycle browser page',
        close: async () => {
          await page.close();
        },
        force: () => page.close().catch(() => {}),
      });
      const response = await page.goto(`http://127.0.0.1:${devServerPort}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 4_000,
      });
      if (!response?.ok()) {
        const body = await response?.text().catch(() => '');
        throw new Error(
          `Native lifecycle browser page returned ${response?.status() ?? 'no response'}: ${body.slice(0, 500)}`,
        );
      }
      try {
        pageVisited = (await page.getByRole('main').innerText({ timeout: 2_000 })) === 'owned native lifecycle page';
      } catch (error) {
        throw new Error(
          `Native lifecycle browser page did not render its main landmark: ${browserDiagnostics.join('; ')}`,
          {
            cause: error,
          },
        );
      }
      report('NATIVE_TIMEOUT_READY', {
        listenerPort,
        devServerPort,
        devServer: devServerIdentity,
        bridgeDirectory: privateBrowser.bridgeDirectory,
        browser: privateBrowser.processIdentity,
        browserNetworkNamespace,
        resistantLeader,
        resistantDescendant,
        pageVisited,
      });
    },
    false,
  );

  try {
    await lifecycle.run('short controlled test-only deadline', 2_500, async () => new Promise<void>(() => {}), false);
  } catch (error) {
    receivedTimeout =
      error instanceof Error && /deadline exceeded in short controlled test-only deadline/iu.test(error.message);
  }
  await lifecycle.close();
  await lifecycle.close();
  report('NATIVE_TIMEOUT_CLEANED', {
    receivedTimeout,
    listenerPort,
    devServerPort,
    devServer: devServerIdentity,
    bridgeDirectory: privateBrowser?.bridgeDirectory,
    browser: privateBrowser?.processIdentity,
    browserNetworkNamespace,
    resistantLeader,
    resistantDescendant,
    pageVisited,
  });
}

async function partialSetupFailure(): Promise<void> {
  const lifecycle = new NativeTestLifecycle('partial native fixture failure injection', undefined, {
    cleanupGraceMs: 500,
    forceGraceMs: 1_000,
  });
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let listenerPort: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let childIdentity: ReturnType<typeof inspectNativeProcess>;
  let expectedFailure = false;
  try {
    await lifecycle.run(
      'deliberate partial native startup failure',
      5_000,
      async () => {
        listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('partial fixture') });
        listenerPort = listener.port;
        const ownedListener = listener;
        lifecycle.register({
          label: 'partially initialized native listener',
          close: () => ownedListener.stop(true),
          force: () => ownedListener.stop(true),
        });
        child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        lifecycle.ownProcessGroup('partially initialized native child', child);
        childIdentity = inspectNativeProcess(child.pid!);
        report('NATIVE_PARTIAL_READY', { listenerPort, child: childIdentity });
        throw new Error('deliberate assertion after partial native fixture setup');
      },
      false,
    );
  } catch (error) {
    expectedFailure =
      error instanceof Error && /deliberate assertion after partial native fixture setup/u.test(error.message);
  }
  await lifecycle.close();
  await lifecycle.close();
  report('NATIVE_PARTIAL_CLEANED', {
    expectedFailure,
    listenerPort,
    child: childIdentity,
  });
}

if (import.meta.main) {
  try {
    await deadlineFailure();
    await partialSetupFailure();
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `Native lifecycle injection failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
