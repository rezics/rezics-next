import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { checkShadcnSync } from '../scripts/shadcn-sync-check';
import { syncShadcn } from '../scripts/shadcn-sync';

const repository = resolve(import.meta.dir, '../../..');
const temporary = join(repository, '.temp', 'shadcn-sync-tests');
const now = new Date('2026-10-27T00:00:00.000Z');
const newestVersion = '4.23.0';

function packageRoot(): string {
  mkdirSync(temporary, { recursive: true });
  return mkdtempSync(join(temporary, 'package-'));
}

function writeState(root: string, syncedAt: string, version = '4.22.1'): void {
  writeFileSync(join(root, 'shadcn-sync.json'), `${JSON.stringify({ syncedAt, version }, null, 2)}\n`);
}

function fakeRegistry() {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ version: newestVersion });
    },
  };
}

test('the reminder opens an issue only when the last sync is older than seven days and none is already open', async () => {
  const cases = [
    { syncedAt: '2026-10-19T23:59:59.999Z', openIssues: [], expected: 'created' },
    { syncedAt: '2026-10-20T00:00:00.000Z', openIssues: [], expected: 'current' },
    { syncedAt: '2026-10-19T23:59:59.999Z', openIssues: [{ number: 42, title: 'Sync shadcn' }], expected: 'existing' },
  ] as const;

  for (const scenario of cases) {
    const root = packageRoot();
    try {
      writeState(root, scenario.syncedAt);
      const registry = fakeRegistry();
      const commands: { command: string; args: string[] }[] = [];
      const runCommand = async (command: string, args: string[]) => {
        commands.push({ command, args });
        if (command !== 'gh') throw new Error(`unexpected command: ${command}`);
        if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify(scenario.openIssues) };
        if (args[0] === 'issue' && args[1] === 'create')
          return { stdout: 'https://github.com/rezics/rezics-next/issues/99\n' };
        throw new Error(`unexpected gh command: ${args.join(' ')}`);
      };

      const result = await checkShadcnSync({ root, now: () => now, fetch: registry.fetch, runCommand });

      expect(result).toBe(scenario.expected);
      expect(registry.requests).toEqual(['https://registry.npmjs.org/shadcn/latest']);
      expect(commands.filter(({ args }) => args[0] === 'issue' && args[1] === 'create').length).toBe(
        scenario.expected === 'created' ? 1 : 0,
      );
      if (scenario.expected === 'created') {
        const create = commands.find(({ args }) => args[0] === 'issue' && args[1] === 'create')!;
        expect(create.args).toContain('--label');
        expect(create.args).toContain('shadcn-sync');
        const body = create.args[create.args.indexOf('--body') + 1]!;
        expect(body).toContain('4.22.1');
        expect(body).toContain(newestVersion);
        expect(body).toContain('bun scripts/shadcn-sync.ts');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the manual sync re-adds every cloned component, refreshes the capability index, pins the latest version, and records the sync', async () => {
  const root = packageRoot();
  try {
    mkdirSync(join(root, 'src', 'shadcn'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'src', 'shadcn', 'button.tsx'), 'old button\n');
    writeFileSync(join(root, 'src', 'shadcn', 'dialog.tsx'), 'old dialog\n');
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: '@rezics/ui', devDependencies: { shadcn: '4.22.1' } }, null, 2)}\n`,
    );
    writeState(root, '2026-10-19T00:00:00.000Z');

    const registry = fakeRegistry();
    const commands: { command: string; args: string[]; cwd: string }[] = [];
    const runCommand = async (command: string, args: string[], options: { cwd: string }) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command === 'bunx') {
        expect(args).toContain('shadcn@latest');
        expect(args).toContain('button');
        expect(args).toContain('dialog');
        writeFileSync(join(root, 'src', 'shadcn', 'button.tsx'), 'upstream button\n');
        writeFileSync(join(root, 'src', 'shadcn', 'dialog.tsx'), 'upstream dialog\n');
        return { stdout: '' };
      }
      if (command === 'bun' && args.join(' ') === 'scripts/shadcn-index.ts') {
        writeFileSync(join(root, 'SHADCN.md'), 'refreshed from the latest registry\n');
        return { stdout: '' };
      }
      if (command === 'bun' && args[0] === 'install') return { stdout: '' };
      if (command === 'git' && args.join(' ') === 'diff --') return { stdout: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };

    const result = await syncShadcn({ root, now: () => now, fetch: registry.fetch, runCommand });

    expect(result).toEqual({ version: newestVersion, syncedAt: now.toISOString() });
    expect(registry.requests).toEqual(['https://registry.npmjs.org/shadcn/latest']);
    expect(
      commands.some(({ command, args }) => command === 'bun' && args.join(' ') === 'scripts/shadcn-index.ts'),
    ).toBe(true);
    expect(commands.some(({ command, args }) => command === 'git' && args.join(' ') === 'diff --')).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.shadcn).toBe(newestVersion);
    expect(JSON.parse(readFileSync(join(root, 'shadcn-sync.json'), 'utf8'))).toEqual({
      syncedAt: now.toISOString(),
      version: newestVersion,
    });
    expect(readFileSync(join(root, 'src', 'shadcn', 'button.tsx'), 'utf8')).toBe('upstream button\n');
    expect(readFileSync(join(root, 'src', 'shadcn', 'dialog.tsx'), 'utf8')).toBe('upstream dialog\n');
    expect(readFileSync(join(root, 'SHADCN.md'), 'utf8')).toContain('latest registry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
