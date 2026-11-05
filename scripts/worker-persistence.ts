import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

type CleanupPlugin = {
  name: string;
  apply: 'serve';
  closeBundle: { order: 'post'; handler(): void };
};

export type WorkerPersistenceApp = 'web' | 'auth';

export type WorkerPersistence = {
  /** Base directory passed to the Cloudflare Vite plugin's persistState.path. */
  directory?: string;
  /** Effective Miniflare resourcePersistencePath, including the plugin's v3 suffix. */
  effectiveDirectory?: string;
  owned: boolean;
  cleanup(): void;
  cleanupPlugin?: CleanupPlugin | undefined;
};

type ConfigContext = { command: string };
type WorkerPersistenceEnvironment = NodeJS.ProcessEnv;

const markerName = '.rezics-worker-persistence-owner';
const byConfig = new WeakMap<object, Map<WorkerPersistenceApp, WorkerPersistence>>();
const ownedLeases = new Set<WorkerPersistence>();
let exitCleanupRegistered = false;

function ownedPrefix(app: WorkerPersistenceApp): string {
  return `rezics-${app}-worker-`;
}

function containedWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function testRuntime(environment: WorkerPersistenceEnvironment): boolean {
  return (
    environment.REZICS_TEST_RUNTIME === '1' ||
    environment.NODE_ENV === 'test' ||
    environment.WEB_TEST_STATE_DIR !== undefined
  );
}

function explicitDirectory(app: WorkerPersistenceApp, environment: WorkerPersistenceEnvironment): string | undefined {
  return app === 'web' ? environment.WEB_TEST_STATE_INSTANCE_DIR : environment.AUTH_TEST_STATE_INSTANCE_DIR;
}

function cleanupPlugin(lease: WorkerPersistence): CleanupPlugin | undefined {
  if (!lease.owned) return undefined;
  return {
    name: 'rezics-worker-persistence-cleanup',
    apply: 'serve',
    closeBundle: {
      order: 'post',
      handler() {
        lease.cleanup();
      },
    },
  };
}

function allocateOwned(app: WorkerPersistenceApp): WorkerPersistence {
  const root = realpathSync(tmpdir());
  const prefix = ownedPrefix(app);
  const directory = mkdtempSync(join(root, prefix));
  const token = randomUUID();
  const owner = join(directory, markerName);
  try {
    writeFileSync(owner, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const canonical = realpathSync(directory);
  if (
    !containedWithin(root, canonical) ||
    basename(canonical) !== basename(directory) ||
    !basename(directory).startsWith(prefix)
  ) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Allocated Worker persistence path escaped os.tmpdir(): ${directory}`);
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    try {
      const current = lstatSync(directory);
      if (current.isSymbolicLink() || !current.isDirectory()) return;
      const resolved = realpathSync(directory);
      if (
        !containedWithin(root, resolved) ||
        basename(resolved) !== basename(directory) ||
        !basename(resolved).startsWith(prefix) ||
        readFileSync(join(resolved, markerName), 'utf8') !== token
      )
        return;
      rmSync(resolved, { recursive: true, force: false });
      cleaned = true;
      ownedLeases.delete(lease);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cleaned = true;
        ownedLeases.delete(lease);
        return;
      }
      throw error;
    }
  };
  const lease: WorkerPersistence = {
    directory,
    effectiveDirectory: resolve(directory, 'v3'),
    owned: true,
    cleanup,
  };
  ownedLeases.add(lease);
  if (!exitCleanupRegistered) {
    process.once('exit', () => {
      for (const owned of ownedLeases) owned.cleanup();
    });
    exitCleanupRegistered = true;
  }
  lease.cleanupPlugin = cleanupPlugin(lease);
  return lease;
}

/**
 * Resolve persistence once for a Vite config evaluation. Re-evaluating the same context returns its existing lease;
 * a second Vite instance has a distinct context and receives a new tmpfs-owned directory.
 */
export function createWorkerPersistence(
  app: WorkerPersistenceApp,
  context: ConfigContext,
  appRoot: string,
  environment: WorkerPersistenceEnvironment = process.env,
): WorkerPersistence {
  let leases = byConfig.get(context);
  if (!leases) {
    leases = new Map();
    byConfig.set(context, leases);
  }
  const previous = leases.get(app);
  if (previous) return previous;

  const explicit = explicitDirectory(app, environment);
  let lease: WorkerPersistence;
  if (explicit !== undefined) {
    const directory = resolve(appRoot, explicit);
    lease = {
      directory,
      effectiveDirectory: resolve(directory, 'v3'),
      owned: false,
      cleanup() {},
    };
  } else if (context.command === 'serve' && testRuntime(environment)) {
    lease = allocateOwned(app);
  } else {
    lease = { owned: false, cleanup() {} };
  }

  if (lease.directory && environment.REZICS_TEST_PERSISTENCE_DIAGNOSTICS === '1')
    process.stderr.write(`[worker-persistence] app=${app} effective=${lease.effectiveDirectory}\n`);
  lease.cleanupPlugin ??= cleanupPlugin(lease);
  leases.set(app, lease);
  return lease;
}
