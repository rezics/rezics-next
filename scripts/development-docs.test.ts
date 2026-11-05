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

test('Imports authority and selected cost cases stay consolidated in their owners', () => {
  const importer = readFileSync(resolve(root, 'services/importer/README.md'), 'utf8');
  const conversion = readFileSync(resolve(root, 'packages/conversion/README.md'), 'utf8');
  const goal = readFileSync(resolve(root, 'docs/goals/imports.md'), 'utf8');
  const capability = readFileSync(resolve(root, 'docs/goals/imports.capabilities.md'), 'utf8');
  const headings = (source: string, title: string) => [...source.matchAll(new RegExp(`^## ${title}$`, 'gm'))];

  expect(headings(importer, 'Registered source vocabulary mapping')).toHaveLength(1);
  expect(headings(importer, 'Shared showcase and media')).toHaveLength(1);
  expect(headings(importer, 'Cost')).toHaveLength(1);
  expect(importer.indexOf('## Registered source vocabulary mapping')).toBeLessThan(
    importer.indexOf('## Shared showcase and media'),
  );
  expect(importer.indexOf('## Shared showcase and media')).toBeLessThan(importer.indexOf('## Cost'));
  expect(importer).not.toContain('## Explicit local showcase publication');

  const operationTable = importer.slice(importer.indexOf('### Operation bounds'));
  const operationNames = operationTable
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .map((line) => line.split('|')[1]?.trim() ?? '')
    .filter((name) => name && name !== 'Operation' && !/^[-: ]+$/.test(name));
  expect(new Set(operationNames).size).toBe(operationNames.length);

  for (const name of [
    'Bangumi PersonDetail acquisition',
    'selected showcase media acquisition and publication',
    'selected VNDB release dates and states',
    'shared reviewed VNDB tags and Kana weights',
    'VNDB work links and franchise relations',
  ]) {
    const start = importer.indexOf(`### Cost: ${name}`);
    const end = importer.indexOf('\n### ', start + 5);
    const section = importer.slice(start, end < 0 ? undefined : end);
    expect(start, `missing Cost section: ${name}`).toBeGreaterThan(importer.indexOf('## Cost'));
    for (const axis of ['**Touches:**', '**Bound:**', '**Growth check:**']) expect(section).toContain(axis);
  }

  expect(Buffer.byteLength(goal, 'utf8')).toBeLessThanOrEqual(12_000);
  for (const [name, source] of [
    ['conversion README', conversion],
    ['importer README', importer],
    ['Imports capability', capability],
  ])
    expect(Buffer.byteLength(source, 'utf8'), `${name} exceeds 40,000 bytes`).toBeLessThanOrEqual(40_000);
  for (const source of [goal, capability]) {
    expect(source).not.toMatch(/^#{1,4} .*Provider review/im);
    expect(source).not.toMatch(/^#{1,4} .*Audit gap/im);
  }
});
