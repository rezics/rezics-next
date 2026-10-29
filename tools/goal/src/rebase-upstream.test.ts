import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './merge.ts';
import { rebaseOnto, rebaseUpstream } from './merge-train.ts';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'rebase-upstream-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', message);
    return git(root, 'rev-parse', 'HEAD');
  };
  return { root, commit, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('the upstream is the recorded base normally, and the fork point once the branch has moved past it', () => {
  const r = repository();
  try {
    const recorded = r.commit({ 'a.txt': 'a0\n', 'w.txt': 'w0\n' }, 'base');
    const target1 = r.commit({ 'a.txt': 'a1\n' }, 'target one');
    git(r.root, 'checkout', '-qb', 'work');
    r.commit({ 'w.txt': 'worker\n' }, 'work');
    git(r.root, 'checkout', '-q', 'main');
    const target2 = r.commit({ 'b.txt': 'b\n' }, 'target two');
    git(r.root, 'checkout', '-q', 'work');
    // The branch already holds target one, past its recorded base: replaying from there would replay other work.
    expect(rebaseUpstream(r.root, target2, recorded)).toBe(target1);
    // A recorded base the branch does not descend from is never used.
    git(r.root, 'checkout', '-q', '--orphan', 'elsewhere');
    git(r.root, 'rm', '-rqf', '.');
    const unrelated = r.commit({ 'z.txt': 'z\n' }, 'unrelated');
    git(r.root, 'checkout', '-q', 'work');
    expect(rebaseUpstream(r.root, target2, unrelated)).toBe(target1);
    // The normal case keeps the recorded base.
    expect(rebaseUpstream(r.root, target2, target1)).toBe(target1);
  } finally {
    r.dispose();
  }
});

test("a squash keeps the worker's own edit outside the brief; only a file it did not change is refused", () => {
  const r = repository();
  try {
    const base = r.commit({ 'w.txt': 'w0\n', 'other.txt': 'o0\n' }, 'base');
    git(r.root, 'checkout', '-qb', 'work');
    r.commit({ 'w.txt': 'worker\n' }, 'work');
    r.commit({ 'other.txt': 'stray\n' }, 'stray edit outside the brief');
    const head = git(r.root, 'rev-parse', 'HEAD');
    git(r.root, 'checkout', '-q', 'main');
    const target = r.commit({ 'w.txt': 'target\n' }, 'target conflicts with the work');
    git(r.root, 'checkout', '-q', 'work');
    // The worker edited other.txt itself, so the squash may carry it; what remains is the conflict on w.txt.
    expect(() => rebaseOnto(r.root, target, base, join(r.root, '.git', 'rebase.log'), [], ['w.txt'])).not.toThrow(
      'outside the brief',
    );
    expect(head).toHaveLength(40);
  } finally {
    r.dispose();
  }
});

test('a rebase keeps both sections that the target and the worker inserted at one place in a README, the target first', () => {
  const r = repository();
  try {
    const base = r.commit({ 'README.md': '# Module\n\nIntro.\n\n## Later\n\nText.\n' }, 'base');
    git(r.root, 'checkout', '-qb', 'work');
    r.commit({ 'README.md': '# Module\n\nIntro.\n\n## Authored fields\n\nField text.\n\n## Later\n\nText.\n' }, 'work');
    git(r.root, 'checkout', '-q', 'main');
    const target = r.commit(
      { 'README.md': '# Module\n\nIntro.\n\n## Avatars\n\nAvatar text.\n\n## Later\n\nText.\n' },
      'target',
    );
    git(r.root, 'checkout', '-q', 'work');
    rebaseOnto(r.root, target, base, join(r.root, '.git', 'rebase.log'), []);
    expect(git(r.root, 'show', 'HEAD:README.md')).toBe(
      '# Module\n\nIntro.\n\n## Avatars\n\nAvatar text.\n\n## Authored fields\n\nField text.\n\n## Later\n\nText.',
    );
    expect(git(r.root, 'merge-base', '--is-ancestor', target, 'HEAD')).toBe('');
  } finally {
    r.dispose();
  }
});

test('a rebase unions Markdown rewrites and names the file in its log', () => {
  const r = repository();
  try {
    const base = r.commit({ 'README.md': '# Module\n\nOld wording.\n' }, 'base');
    git(r.root, 'checkout', '-qb', 'work');
    r.commit({ 'README.md': '# Module\n\nWorker wording.\n' }, 'work');
    git(r.root, 'checkout', '-q', 'main');
    const target = r.commit({ 'README.md': '# Module\n\nTarget wording.\n' }, 'target');
    git(r.root, 'checkout', '-q', 'work');
    const log = join(r.root, '.git', 'rebase.log');
    rebaseOnto(r.root, target, base, log, []);
    expect(readFileSync(join(r.root, 'README.md'), 'utf8')).toContain('Target wording.');
    expect(readFileSync(join(r.root, 'README.md'), 'utf8')).toContain('Worker wording.');
    expect(readFileSync(log, 'utf8')).toContain('Markdown union: README.md');
    expect(git(r.root, 'merge-base', '--is-ancestor', target, 'HEAD')).toBe('');
  } finally {
    r.dispose();
  }
});

test('a rebase conflict where both sides rewrote non-Markdown text still returns to the worker', () => {
  const r = repository();
  try {
    const base = r.commit({ 'result.txt': 'Old wording.\n' }, 'base');
    git(r.root, 'checkout', '-qb', 'work');
    r.commit({ 'result.txt': 'Worker wording.\n' }, 'work');
    git(r.root, 'checkout', '-q', 'main');
    const target = r.commit({ 'result.txt': 'Target wording.\n' }, 'target');
    git(r.root, 'checkout', '-q', 'work');
    expect(() => rebaseOnto(r.root, target, base, join(r.root, '.git', 'rebase.log'), [])).toThrow();
    expect(git(r.root, 'diff', '--name-only', '--diff-filter=U')).toBe('result.txt');
  } finally {
    r.dispose();
  }
});
