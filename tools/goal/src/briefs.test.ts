import { expect, test } from 'bun:test';
import { controlPlaneReleaseBrief, devProductBrief, MAX_BRIEF_BYTES, parseBrief } from './briefs.ts';
import { markdown } from './test-support.ts';

test('a brief over the size limit is refused with the reason, since the prompt is one launch argument', () => {
  expect(() => parseBrief(markdown, { version: 1, areas: {} })).not.toThrow();
  const big = `${markdown}\n${'x'.repeat(MAX_BRIEF_BYTES)}\n`;
  expect(() => parseBrief(big, { version: 1, areas: {} })).toThrow('link evidence files instead of pasting them');
});

test('acceptance placement is optional, typed, and restricts local checks to the audited command boundary', () => {
  const ownership = { version: 1 as const, areas: {} };
  const local = markdown.replace(
    '  command: [bun, test]',
    '  command: [bun, test, apps/web/tests/shell-menus.test.ts]\n  placement: local',
  );
  expect(parseBrief(local, ownership).acceptance.placement).toBe('local');
  expect(parseBrief(markdown, ownership).acceptance.placement).toBeUndefined();
  expect(
    parseBrief(markdown.replace('  command: [bun, test]', '  command: [bun, test]\n  placement: default'), ownership)
      .acceptance.placement,
  ).toBe('default');

  for (const invalid of [
    markdown.replace('  command: [bun, test]', '  command: [bun, test]\n  placement: remote'),
    markdown.replace('  command: [bun, test]', '  command: [bun, test]\n  placement: local'),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, services/kernel/scripts/check.ts]\n  placement: local',
    ),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, apps/web/tests/example.host.test.ts]\n  placement: local',
    ),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, tools/goal/src/briefs.test.ts]\n  placement: local',
    ),
  ]) {
    expect(() => parseBrief(invalid, ownership)).toThrow();
  }
});

test('verification briefs require typed proof metadata and reject source editing, frozen inputs and priority', () => {
  const proof = markdown
    .replace('kind: implementation', 'kind: verification')
    .replace('paths: [result.txt]', 'paths: []')
    .replace('estimate:\n  lines: 100\n  files: 4\n', '')
    .replace(
      'riskAreas: []',
      `riskAreas: []\nproof:\n  journey: Original journey\n  sourceTasks: [original]\n  sourceCommit: ${'a'.repeat(40)}`,
    );
  const ownership = { version: 1 as const, areas: {} };
  expect(parseBrief(proof, ownership).proof?.sourceTasks).toEqual(['original']);
  for (const invalid of [
    proof.replace('paths: []', 'paths: [product.ts]'),
    proof.replace('criticalPath: false', 'criticalPath: true'),
    `${proof}\n\`\`\`ts path=product.ts\nexport const changed = true;\n\`\`\``,
    proof.replace('  journey: Original journey', '  authorized: true\n  journey: Original journey'),
    proof.replace('kind: verification', 'kind: implementation'),
  ])
    expect(() => parseBrief(invalid, ownership)).toThrow();
});

test('untargeted control-plane work is dev work; main targeting is reserved for control-plane releases', () => {
  const ownership = { version: 1 as const, areas: {} };
  const controlPlane = markdown.replace('goal: fixture', 'goal: control-plane');
  const dev = parseBrief(controlPlane, ownership);
  expect(dev.target).toBeUndefined();
  expect(controlPlaneReleaseBrief(dev)).toBe(false);
  expect(devProductBrief(dev)).toBe(true);
  for (const target of ['main', 'stabilize'] as const) {
    const release = parseBrief(
      controlPlane.replace('goal: control-plane', `goal: control-plane\ntarget: ${target}`),
      ownership,
    );
    expect(release.target).toBe(target);
    expect(controlPlaneReleaseBrief(release)).toBe(true);
    expect(devProductBrief(release)).toBe(false);
  }
  expect(() => parseBrief(markdown.replace('goal: fixture', 'goal: fixture\ntarget: main'), ownership)).toThrow(
    'only a control-plane brief can target main',
  );
});
