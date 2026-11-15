import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDocsCheck } from './docs-check';

let root: string;

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commit(message = 'fixture base'): void {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', message], { cwd: root, stdio: 'ignore' });
}

function initRepo(options: { budgets?: unknown; baseline?: unknown; reports?: unknown[] } = {}): void {
  root = mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'docs-check@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Docs Check'], { cwd: root });
  write('docs/budgets.json', `${JSON.stringify(options.budgets ?? { version: 1, budgets: [] }, null, 2)}\n`);
  write('docs/budgets-baseline.json', `${JSON.stringify(options.baseline ?? { version: 1, entries: [] }, null, 2)}\n`);
  write('docs/research/registry.json', `${JSON.stringify({ reports: options.reports ?? [] }, null, 2)}\n`);
  write('README.md', '# Fixture\n');
  commit();
}

function output(result: Awaited<ReturnType<typeof runDocsCheck>>): string {
  return result.lines.join('\n');
}

beforeEach(() => {
  initRepo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('documentation budgets and registry', () => {
  test('reports a new over-cap file with its rule, path, size and remedy', async () => {
    write('docs/development/oversized.md', '123456789');
    write(
      'docs/budgets.json',
      JSON.stringify({ version: 1, budgets: [{ path: 'docs/development/*.md', kind: 'file', bytes: 8 }] }),
    );
    const result = await runDocsCheck(root);
    expect(result.exitCode).toBe(1);
    expect(output(result)).toContain(
      'budget-cap | docs/development/oversized.md | size 9 bytes exceeds cap 8 bytes | remedy:',
    );
  });

  test('uses the more specific capability-file budget', async () => {
    write('docs/goals/feature.capabilities.md', 'x'.repeat(13_000));
    write(
      'docs/budgets.json',
      JSON.stringify({
        version: 1,
        budgets: [
          { path: 'docs/goals/*.md', kind: 'file', bytes: 12_000 },
          { path: 'docs/goals/*.capabilities.*', kind: 'file', bytes: 40_000 },
        ],
      }),
    );
    expect((await runDocsCheck(root)).exitCode).toBe(0);
  });

  test('rejects growth above a baseline entry', async () => {
    write('docs/development/large.md', '1234');
    write(
      'docs/budgets.json',
      JSON.stringify({ version: 1, budgets: [{ path: 'docs/development/*.md', kind: 'file', bytes: 2 }] }),
    );
    write(
      'docs/budgets-baseline.json',
      JSON.stringify({ version: 1, entries: [{ path: 'docs/development/large.md', bytes: 4 }] }),
    );
    commit();
    write('docs/development/large.md', '12345');
    const result = await runDocsCheck(root);
    expect(output(result)).toContain(
      'budget-growth | docs/development/large.md | size 5 bytes exceeds baseline 4 bytes | remedy:',
    );
  });

  test('rejects a baseline increase without a Budget-Raise trailer', async () => {
    write('docs/large.md', '1234');
    write('docs/budgets-baseline.json', JSON.stringify({ version: 1, entries: [{ path: 'docs/large.md', bytes: 4 }] }));
    commit();
    write('docs/budgets-baseline.json', JSON.stringify({ version: 1, entries: [{ path: 'docs/large.md', bytes: 5 }] }));
    const result = await runDocsCheck(root);
    expect(output(result)).toContain(
      'baseline-raise | docs/large.md | size 5 bytes raises the committed baseline from 4 bytes | remedy: add a Budget-Raise:',
    );
  });

  test('registers missing reports and refuses invalid research states', async () => {
    write('docs/research/new-topic.md', '# New topic\n');
    execFileSync('git', ['add', 'docs/research/new-topic.md'], { cwd: root });
    write('docs/research/known.md', '# Known\n');
    write(
      'docs/research/registry.json',
      JSON.stringify({
        reports: [{ path: 'docs/research/known.md', topic: 'known', researcher: 'tester', state: 'pending' }],
      }),
    );
    const result = await runDocsCheck(root);
    expect(output(result)).toContain('research-unregistered | docs/research/new-topic.md');
    expect(output(result)).toContain(
      'research-state | docs/research/known.md | invalid state pending | remedy: use open, adopted or rejected',
    );
  });

  test('recognizes registered aliases only when their target is a tracked Markdown file inside the repository', async () => {
    write('tools/research/original.md', '# Original report\n');
    mkdirSync(path.join(root, 'docs/research'), { recursive: true });
    symlinkSync('../../tools/research/original.md', path.join(root, 'docs/research/alias.md'));
    symlinkSync(process.execPath, path.join(root, 'docs/research/external.md'));
    write(
      'docs/research/registry.json',
      JSON.stringify({
        reports: [
          { path: 'docs/research/alias.md', topic: 'alias', researcher: 'tester', state: 'open' },
          { path: 'docs/research/external.md', topic: 'external', researcher: 'tester', state: 'open' },
        ],
      }),
    );
    commit();
    const result = output(await runDocsCheck(root));
    expect(result).not.toContain('research-missing | docs/research/alias.md');
    expect(result).toContain('research-missing | docs/research/external.md');
    rmSync(path.join(root, 'tools/research/original.md'));
    expect(output(await runDocsCheck(root))).toContain('research-missing | docs/research/alias.md');
  });

  test('reports a shrink and lowers a baseline entry without raising it', async () => {
    write('docs/large.md', '12345678');
    write(
      'docs/budgets.json',
      JSON.stringify({ version: 1, budgets: [{ path: 'docs/large.md', kind: 'file', bytes: 4 }] }),
    );
    write('docs/budgets-baseline.json', JSON.stringify({ version: 1, entries: [{ path: 'docs/large.md', bytes: 8 }] }));
    commit('fixture seed\n\nBudget-Raise: seed the oversized fixture');
    write('docs/large.md', '12345');
    const before = await runDocsCheck(root);
    expect(before.exitCode, output(before)).toBe(0);
    expect(output(before)).toContain(
      'budget-shrank | docs/large.md | size 5 bytes is below baseline 8 bytes | remedy:',
    );
    const lowered = await runDocsCheck(root, ['--update-baseline']);
    expect(lowered.exitCode, output(lowered)).toBe(0);
    expect(output(lowered)).toContain('baseline-lowered | docs/large.md | size lowered to 5 bytes');
    expect(JSON.parse(readFileSync(path.join(root, 'docs/budgets-baseline.json'), 'utf8')).entries[0].bytes).toBe(5);
    rmSync(path.join(root, 'docs/large.md'));
    expect(output(await runDocsCheck(root))).toContain(
      'budget-shrank | docs/large.md | size 0 bytes is below baseline 5 bytes',
    );
    expect(output(await runDocsCheck(root, ['--update-baseline']))).toContain(
      'baseline-lowered | docs/large.md | size lowered to 0 bytes',
    );
  });
});

describe('documentation links and owner rules', () => {
  test('keeps unavailable historical references informational and current owner links actionable', async () => {
    write('docs/research/old.md', '[old evidence](../../.temp/old.json)\n');
    write(
      'docs/research/registry.json',
      JSON.stringify({
        reports: [{ path: 'docs/research/old.md', topic: 'old', researcher: 'tester', state: 'open' }],
      }),
    );
    const historical = await runDocsCheck(root);
    expect(historical.exitCode, output(historical)).toBe(0);
    expect(output(historical)).toContain('historical-link-target | docs/research/old.md');
    write('docs/development/current.md', '[owner](./missing.md)\n');
    const current = await runDocsCheck(root);
    expect(current.exitCode).toBe(1);
    expect(output(current)).toContain('link-target | docs/development/current.md');
  });

  test('leaves untracked report registration pending until its source is staged', async () => {
    write('docs/research/draft.md', '# Draft\n');
    const draft = await runDocsCheck(root);
    expect(draft.exitCode, output(draft)).toBe(0);
    expect(output(draft)).toContain('research-pending | docs/research/draft.md');
    execFileSync('git', ['add', 'docs/research/draft.md'], { cwd: root });
    expect(output(await runDocsCheck(root))).toContain('research-unregistered | docs/research/draft.md');
  });

  test('distinguishes terminology and runnable examples from live task and private-state references', async () => {
    write(
      'docs/development/owner.md',
      [
        'A task-specific goal-author follows the task-custody protocol.',
        'Write output to `.temp/screenshots`.',
        '```sh',
        'tool --out .temp/screenshots # TASK-ABCD',
        '```',
        'Use `00000000-0000-0000-0000-000000000000` as an example nonce.',
      ].join('\n'),
    );
    const examples = await runDocsCheck(root);
    expect(examples.exitCode, output(examples)).toBe(0);
    write(
      'docs/development/owner.md',
      'Read `.temp/goal/private.json`.\n[authority](../../.temp/current.md)\nTask TASK-ABCD\n',
    );
    const live = output(await runDocsCheck(root));
    expect(live).toContain('owner-temp-path | docs/development/owner.md');
    expect(live).toContain('owner-task-id | docs/development/owner.md');
  });

  test('ignores generated marker examples but retains malformed and stale standalone blocks', async () => {
    write(
      'docs/development/examples.md',
      [
        'Use `<!-- generated: path -->` and `<!-- /generated -->` markers.',
        '```md',
        '<!-- generated: absent.txt -->',
        'example',
        '<!-- /generated -->',
        '```',
      ].join('\n'),
    );
    expect((await runDocsCheck(root)).exitCode).toBe(0);
    write('docs/development/examples.md', '<!-- generated: absent.txt -->\nunclosed\n');
    expect(output(await runDocsCheck(root))).toContain('generated block markers are incomplete');
  });
  test('checks relative targets and anchors and includes inbound links to deleted files', async () => {
    write('docs/development/source.md', '[gone](../gone.md#missing) and [anchor](./target.md#absent)\n');
    write('docs/development/target.md', '# Present\n');
    write('docs/development/inbound.md', '[removed](./deleted.md)\n');
    write('docs/development/deleted.md', '# Deleted\n');
    commit();
    const full = await runDocsCheck(root);
    expect(output(full)).toContain(
      'link-target | docs/development/source.md | target ../gone.md#missing does not resolve',
    );
    expect(output(full)).toContain(
      'link-anchor | docs/development/source.md | target ./target.md#absent has no matching anchor',
    );
    rmSync(path.join(root, 'docs/development/deleted.md'));
    const changed = await runDocsCheck(root, ['--changed', 'HEAD']);
    expect(output(changed)).toContain(
      'link-target | docs/development/inbound.md | target ./deleted.md does not resolve',
    );
  });

  test('changed mode checks changed Markdown without scanning unrelated broken links', async () => {
    write('docs/development/unchanged.md', '[gone](./missing.md)\n');
    commit();
    write('docs/development/changed.md', '# Safe\n');
    const result = await runDocsCheck(root, ['--changed', 'HEAD']);
    expect(result.exitCode).toBe(0);
  });

  test('changed mode ignores tracked temporary Markdown missing from the work tree', async () => {
    write('.temp/continuation/kept.md', '# Continuation\n');
    write('docs/development/plan.md', '[next](../../.temp/continuation/kept.md)\n');
    write('docs/development/changed.md', '# First\n');
    commit();
    write('docs/development/changed.md', '# Second\n');
    commit('docs');
    rmSync(path.join(root, '.temp/continuation/kept.md'));
    const result = await runDocsCheck(root, ['--changed', 'HEAD~1']);
    expect(result.exitCode).toBe(0);
  });

  test('finds dated headings, task IDs and temporary paths in owner documents', async () => {
    write('docs/development/owner.md', '## 2026-11-05 Notes\nTask TASK-ABCD\nSee .temp/continuation/next.md\n');
    const result = await runDocsCheck(root);
    expect(output(result)).toContain('owner-dated-heading | docs/development/owner.md');
    expect(output(result)).toContain('owner-task-id | docs/development/owner.md');
    expect(output(result)).toContain('owner-temp-path | docs/development/owner.md');
  });

  test('checks generated blocks against their source bytes', async () => {
    write('scripts/render.txt', 'current render\n');
    write(
      'docs/development/generated.md',
      '<!-- generated: scripts/render.txt -->\nstale render\n<!-- /generated -->\n',
    );
    expect(output(await runDocsCheck(root))).toContain(
      'generated-block | docs/development/generated.md | render from scripts/render.txt differs from the block',
    );
  });

  test('detects a newly tracked temporary file', async () => {
    write('.temp/new.md', 'temporary\n');
    execFileSync('git', ['add', '.temp/new.md'], { cwd: root });
    const result = await runDocsCheck(root);
    expect(output(result)).toContain('tracked-temp | .temp/new.md | newly tracked temporary file | remedy:');
    commit();
    expect(output(await runDocsCheck(root))).toContain(
      'tracked-temp | .temp/new.md | newly tracked temporary file | remedy:',
    );
  });
});

test('changed Markdown excludes missing temporary notes and tolerates a vanished optional note', async () => {
  write('.temp/optional.md', '[broken](./missing.md)\n');
  execFileSync('git', ['add', '.temp/optional.md'], { cwd: root });
  commit();
  rmSync(path.join(root, '.temp/optional.md'));
  write('optional.md', '# Optional\n');
  const markdownStat = (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]).endsWith('/optional.md'))
      throw Object.assign(new Error('optional note vanished'), { code: 'ENOENT' });
    return lstat(...args);
  }) as typeof lstat;
  const result = await runDocsCheck(root, ['--changed', 'HEAD'], { markdownStat });
  expect(result.exitCode).toBe(0);
  expect(output(result)).not.toContain('link-target');
});

test('a live owner document retains its stat I/O diagnostic instead of appearing empty', async () => {
  write('docs/development/owner.md', '# Owner\n[dependency](./dependency.md)\n');
  const failure = Object.assign(new Error('permission denied by fixture'), { code: 'EACCES' });
  const markdownStat = (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]).endsWith('/docs/development/owner.md')) throw failure;
    return lstat(...args);
  }) as typeof lstat;
  await expect(runDocsCheck(root, [], { markdownStat })).rejects.toThrow(
    'docs-check: cannot stat docs/development/owner.md: Error: permission denied by fixture',
  );
});

describe('brief dispatch checks', () => {
  test('refuses oversized briefs, temporary goal reads, main-checkout paths and research authority', async () => {
    write('oversized.md', 'x'.repeat(12_289));
    expect(output(await runDocsCheck(root, ['--brief', 'oversized.md']))).toContain('brief-size | oversized.md');
    write('private.md', 'Read .temp/goal/state.md\n');
    expect(output(await runDocsCheck(root, ['--brief', 'private.md']))).toContain('brief-private-state | private.md');
    write('main.md', 'Read /home/edge/projects/rezics/rezics-next/.temp/goal/brief.md\n');
    expect(output(await runDocsCheck(root, ['--brief', 'main.md']))).toContain('brief-main-checkout | main.md');
    write('research.md', 'Authority: docs/research/example.md\n');
    expect(output(await runDocsCheck(root, ['--brief', 'research.md']))).toContain(
      'brief-research-authority | research.md',
    );
  });
});
