import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import {
  currentNativeLifecycle,
  settledWithin,
  type NativeProcessIdentity,
  type NativeProcessOwnership,
} from './lifecycle.ts';

export type PrivateBrowser = {
  browser: Browser;
  bridgeDirectory: string;
  processIdentity: NativeProcessIdentity;
  close(): Promise<void>;
  force(): Promise<void>;
};

const maxFrameBytes = Math.ceil((16 * 1024 * 1024 * 4) / 3) + 1024 * 1024;
const repositoryRoot = resolve(import.meta.dir, '../../../..');

type BridgeRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
};
type BridgeResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};

export async function launchPrivateBrowser(allowedOrigins: readonly string[]): Promise<PrivateBrowser> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Private browser startup requires an active native test lifecycle');
  lifecycle.assertOpen('start private browser');

  const probe = Bun.spawnSync(['unshare', '--user', '--map-root-user', '--net', 'true'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (probe.exitCode !== 0)
    throw new Error(
      `Private browser network namespace probe failed: ${probe.stderr.toString().trim() || probe.exitCode}`,
    );

  const allowed = new Set(allowedOrigins.map((value) => new URL(value).origin));
  const directory = join(repositoryRoot, '.temp', `pb-${crypto.randomUUID().slice(0, 8)}`);
  const socketPath = join(directory, 'bridge.sock');
  const localProxyPort = await freePort();
  lifecycle.assertOpen('create private browser bridge');
  await mkdir(directory, { recursive: true });

  let active = 0;
  let bridgeClosed = false;
  const waiters: (() => void)[] = [];
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const withSlot = async <T>(run: () => Promise<T>): Promise<T> => {
    if (bridgeClosed) throw new Error('Private browser bridge is closing');
    if (active >= 8) await new Promise<void>((resolveSlot) => waiters.push(resolveSlot));
    if (bridgeClosed) throw new Error('Private browser bridge is closing');
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };

  const bridge = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxFrameBytes) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      void withSlot(async () => {
        let controller: AbortController | undefined;
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeRequest;
          const target = new URL(request.url);
          if (target.protocol !== 'http:' || !allowed.has(target.origin)) {
            sendBridgeResponse(socket, {
              status: 403,
              statusText: 'Forbidden',
              headers: [['content-type', 'text/plain; charset=utf-8']],
              body: Buffer.from('Origin is outside this private browser receipt').toString('base64'),
            });
            return;
          }
          const headers = new Headers(request.headers);
          for (const name of [
            'accept-encoding',
            'connection',
            'content-length',
            'host',
            'keep-alive',
            'proxy-connection',
            'transfer-encoding',
          ])
            headers.delete(name);
          const body = Buffer.from(request.body, 'base64');
          controller = new AbortController();
          controllers.add(controller);
          const response = await fetch(target, {
            method: request.method,
            headers,
            ...(body.length && request.method !== 'GET' && request.method !== 'HEAD' ? { body } : {}),
            redirect: 'manual',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
          });
          const responseBody = Buffer.from(await response.arrayBuffer());
          if (responseBody.length > maxFrameBytes)
            throw new Error('Private browser bridge response exceeded its size bound');
          const responseHeaders: [string, string][] = [];
          for (const [name, value] of response.headers) {
            if (name !== 'set-cookie') responseHeaders.push([name, value]);
          }
          for (const cookie of response.headers.getSetCookie()) responseHeaders.push(['set-cookie', cookie]);
          sendBridgeResponse(socket, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody.toString('base64'),
          });
        } catch (error) {
          if (!socket.destroyed)
            sendBridgeResponse(socket, {
              status: 502,
              statusText: 'Bad Gateway',
              headers: [['content-type', 'text/plain; charset=utf-8']],
              body: Buffer.from(error instanceof Error ? error.message : String(error)).toString('base64'),
            });
        } finally {
          if (controller) controllers.delete(controller);
        }
      }).catch(() => socket.destroy());
    });
  });

  const forceBridgeClose = async (): Promise<void> => {
    bridgeClosed = true;
    for (const controller of controllers) controller.abort(new Error('Private browser bridge force-closed'));
    for (const socket of sockets) socket.destroy();
    for (const wake of waiters.splice(0)) wake();
    await settledWithin(
      new Promise<void>((resolveClose) => {
        if (!bridge.listening) return resolveClose();
        bridge.close(() => resolveClose());
      }),
      500,
    );
  };
  const closeBridge = async (): Promise<void> => {
    if (bridgeClosed) return;
    await forceBridgeClose();
  };
  const cleanDirectory = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  };
  lifecycle.register({ label: 'private browser bridge', close: closeBridge, force: forceBridgeClose });
  lifecycle.register({ label: 'private browser temporary files', close: cleanDirectory, force: cleanDirectory });

  try {
    await new Promise<void>((resolveListen, reject) => {
      bridge.once('error', reject);
      bridge.listen(socketPath, resolveListen);
    });
  } catch (error) {
    await forceBridgeClose();
    await cleanDirectory();
    throw error;
  }

  const namespaceScript = join(directory, 'namespace.sh');
  const launcherScript = join(directory, 'launch-chromium');
  await writeFile(
    namespaceScript,
    `#!/bin/sh
set -eu
ip link set lo up
"$NATIVE_BROWSER_BUN" "$NATIVE_BROWSER_PROXY" "$NATIVE_BROWSER_PROXY_PORT" "$NATIVE_BROWSER_SOCKET" &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true' EXIT HUP INT TERM
attempt=0
while [ "$attempt" -lt 100 ]; do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    wait "$proxy_pid"
    exit 1
  fi
  if "$NATIVE_BROWSER_BUN" -e "await fetch('http://127.0.0.1:$NATIVE_BROWSER_PROXY_PORT/__native_ready')" >/dev/null 2>&1; then break; fi
  attempt=$((attempt + 1))
  sleep 0.05
done
if [ "$attempt" -ge 100 ]; then exit 1; fi
"$NATIVE_BROWSER_CHROMIUM" "$@"
`,
    { mode: 0o700 },
  );
  lifecycle.assertOpen('write private browser launcher');
  await writeFile(
    launcherScript,
    `#!/bin/sh
exec unshare --user --map-root-user --net /bin/sh "$NATIVE_BROWSER_NAMESPACE_SCRIPT" "$@"
`,
    { mode: 0o700 },
  );
  lifecycle.assertOpen('make private browser launcher executable');
  await chmod(namespaceScript, 0o700);
  await chmod(launcherScript, 0o700);

  let browser: Browser | undefined;
  let browserServer: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  let closing: Promise<void> | undefined;
  let processOwnership: NativeProcessOwnership | undefined;
  let browserServerClosed = false;
  const closeBrowserServer = async (): Promise<void> => {
    if (!browserServer || browserServerClosed) return;
    const closed = await settledWithin(
      browserServer.close().then(() => true),
      2_000,
    );
    if (!closed) throw new Error('Private browser server close exceeded 2000ms');
    browserServerClosed = true;
  };
  try {
    lifecycle.assertOpen('launch private browser');
    browserServer = await chromium.launchServer({
      executablePath: launcherScript,
      args: [`--proxy-server=http://127.0.0.1:${localProxyPort}`, '--proxy-bypass-list=<-loopback>'],
      env: {
        ...process.env,
        NATIVE_BROWSER_BUN: process.execPath,
        NATIVE_BROWSER_CHROMIUM: chromium.executablePath(),
        NATIVE_BROWSER_NAMESPACE_SCRIPT: namespaceScript,
        NATIVE_BROWSER_PROXY: resolve(import.meta.dir, 'private-browser-host.ts'),
        NATIVE_BROWSER_PROXY_PORT: String(localProxyPort),
        NATIVE_BROWSER_SOCKET: socketPath,
      },
    });
    processOwnership = lifecycle.ownProcessGroup('private browser namespace', browserServer.process());
    lifecycle.assertOpen('connect private browser');
    browser = await chromium.connect(browserServer.wsEndpoint());
    let forceClosing: Promise<void> | undefined;
    lifecycle.register({
      label: 'private browser',
      close: async () => {
        if (browser?.isConnected()) {
          const disconnected = await settledWithin(
            browser.close().then(() => true),
            3_000,
          );
          if (!disconnected) throw new Error('Private browser disconnect exceeded 3000ms');
        }
        await closeBrowserServer();
      },
      force: () =>
        (forceClosing ??= (async () => {
          if (processOwnership) await processOwnership.force();
          await forceBridgeClose();
          await cleanDirectory();
        })()),
    });
    return {
      browser,
      bridgeDirectory: directory,
      processIdentity: processOwnership.identity,
      async force() {
        if (processOwnership) await processOwnership.force();
        await forceBridgeClose();
        await cleanDirectory();
      },
      close() {
        return (closing ??= (async () => {
          const errors: unknown[] = [];
          if (browser?.isConnected())
            try {
              const disconnected = await settledWithin(
                browser.close().then(() => true),
                3_000,
              );
              if (!disconnected) throw new Error('Private browser disconnect exceeded 3000ms');
            } catch (error) {
              errors.push(error);
            }
          try {
            await closeBrowserServer();
          } catch (error) {
            errors.push(error);
          }
          try {
            await closeBridge();
          } catch (error) {
            errors.push(error);
          }
          try {
            await cleanDirectory();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length) throw new AggregateError(errors, 'Private browser cleanup failed');
        })());
      },
    };
  } catch (error) {
    if (processOwnership) await processOwnership.force().catch(() => {});
    else if (browserServer)
      await settledWithin(
        browserServer.close().then(() => true),
        2_000,
      ).catch(() => {});
    else if (browser)
      await settledWithin(
        browser.close().then(() => true),
        2_000,
      ).catch(() => {});
    await forceBridgeClose();
    await cleanDirectory();
    throw error;
  }
}

function sendBridgeResponse(socket: Socket, response: BridgeResponse): void {
  if (socket.destroyed) return;
  socket.end(JSON.stringify(response));
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}
