import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const root = resolve(import.meta.dir, '..');
const workflow = ['README', 'feature-design', 'delivery', 'verification', 'efficiency', 'maintenance'];
const goals = ['accounts', 'semantic', 'search', 'content', 'commerce', 'imports', 'web', 'performance'];
const documents = [
  'AGENTS.md',
  'docs/architecture.md',
  ...workflow.map((name) => `docs/development/${name}.md`),
  'docs/goals/README.md',
  ...goals.map((name) => `docs/goals/${name}.md`),
];

function links(file: string): string[] {
  return [...readFileSync(resolve(root, file), 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[a-z]+:|^#/i.test(target))
    .map((target) => relative(root, resolve(root, dirname(file), target.split('#')[0]!)));
}

test('the development workflow and every Goal definition are tracked documents, linked from AGENTS.md', () => {
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
  const reachable = new Set<string>();
  const pending = ['AGENTS.md'];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    if (!documents.includes(file)) continue;
    const targets = links(file);
    for (const target of targets) {
      expect(existsSync(resolve(root, target)), `${file} links to missing ${target}`).toBe(true);
      pending.push(target);
    }
  }
  for (const file of documents) {
    expect(tracked.has(file), `${file} must be tracked`).toBe(true);
    expect(reachable.has(file), `${file} must be reachable from AGENTS.md`).toBe(true);
    expect(readFileSync(resolve(root, file), 'utf8').trim().length).toBeGreaterThan(0);
  }
  for (const goal of goals) {
    const text = readFileSync(resolve(root, `docs/goals/${goal}.md`), 'utf8');
    expect([...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      'Outcome',
      'Done when',
      'Scope',
      'Ownership',
      'Dependencies',
      'Acceptance',
      'External conditions',
    ]);
  }
});
