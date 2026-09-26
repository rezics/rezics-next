import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { archiveLimits, collisionKey, confinedPath } from './install-archive.ts';
import type { HookExecutor } from './install.ts';

/** The linux/amd64 manifest, not a mutable tag or multi-platform index. */
export const NODE_HOOK_IMAGE = 'docker.io/library/node:26.8.2-bookworm-slim@sha256:6e685d638c472d81fdf86b944e3487f0d3b5e747d5099f936d4d2256cd1201d5';
export const NODE_HOOK_PROFILE = 'rezics-node26-docker-v1';
const ALLOWED = new Set(['preinstall', 'install', 'postinstall']);
const DEADLINE_MS = 30_000;

/** Docker has no host credentials, network, Docker socket or mount outside one staged package. */
export class DockerNodeHookExecutor implements HookExecutor {
  readonly profile = NODE_HOOK_PROFILE;

  /** `searchPath` comes from the composition root; hooks never read the service environment. */
  constructor(private readonly rootDirectory: string, private readonly searchPath = '/usr/bin:/bin') {}

  async run(input: { instanceKey: string; directory: string; hooks: string[] }): Promise<void> {
    const root = await realpath(this.rootDirectory);
    const directory = await realpath(input.directory);
    const within = relative(root, directory);
    if (!within || within.startsWith('..') || isAbsolute(within)) {
      throw new Error('hook staging directory is outside the installation root');
    }
    if (!input.hooks.length || input.hooks.length > 3 || new Set(input.hooks).size !== input.hooks.length) {
      throw new Error('hook list is invalid');
    }
    const manifestPath = resolve(directory, 'package.json');
    const manifestStat = await stat(manifestPath);
    if (manifestStat.size > 1024 * 1024) throw new Error('hook manifest exceeds the byte budget');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts = manifest.scripts ?? {};
    for (const name of input.hooks) {
      if (!ALLOWED.has(name) || typeof scripts[name] !== 'string' || !scripts[name]
        || scripts[name].length > 8192) throw new Error(`hook ${name} is not executable from the staged manifest`);
      await this.runOne(directory, scripts[name]);
      await this.checkOutput(directory);
    }
  }

  private async checkOutput(root: string): Promise<void> {
    const pending = [''];
    const seen = new Set<string>();
    let count = 0;
    let bytes = 0;
    while (pending.length) {
      const parent = pending.pop()!;
      for (const name of await readdir(join(root, parent))) {
        const path = parent ? `${parent}/${name}` : name;
        if (!confinedPath(path)) throw new Error('hook output escaped its package');
        const folded = collisionKey(path);
        if (seen.has(folded)) throw new Error('hook output has a case collision');
        seen.add(folded);
        if (++count > archiveLimits.entries) throw new Error('hook output entry budget exceeded');
        const full = join(root, path);
        const entry = await lstat(full);
        if (entry.isSymbolicLink()) {
          const target = await readlink(full);
          const resolved = posix.normalize(posix.join(posix.dirname(path), target));
          if (target.startsWith('/') || !confinedPath(resolved)) {
            throw new Error('hook output has an escaping symlink');
          }
        } else if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.nlink === 1) {
          bytes += entry.size;
          if (bytes > archiveLimits.expandedBytes) throw new Error('hook output byte budget exceeded');
        } else throw new Error('hook output has an unsupported entry');
      }
    }
  }

  private async runOne(directory: string, script: string): Promise<void> {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!uid || gid === undefined) throw new Error('hook executor requires a non-root host user');
    const container = `rezics-hook-${randomUUID()}`;
    const command = ['docker', 'run', '--rm', '--name', container, '--platform', 'linux/amd64',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64',
      '--ulimit', 'fsize=67108864:67108864', '--ulimit', 'nofile=256:256',
      '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp',
      '--env', 'PATH=/work/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
      '--mount', `type=bind,src=${directory},dst=/work`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--workdir', '/work', NODE_HOOK_IMAGE, '/bin/sh', '-euc', script];
    let timedOut = false;
    try {
      const child = Bun.spawn(command, { env: { PATH: this.searchPath },
        stdout: 'ignore', stderr: 'ignore' });
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, DEADLINE_MS);
      try {
        const exit = await child.exited;
        if (exit !== 0 || timedOut) throw new Error(timedOut ? 'hook deadline exceeded' : 'hook failed');
      } finally { clearTimeout(timeout); }
    } finally {
      const cleanup = Bun.spawn(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
      await cleanup.exited;
    }
  }
}
