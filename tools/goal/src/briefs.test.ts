import { expect, test } from 'bun:test';
import { MAX_BRIEF_BYTES, parseBrief } from './briefs.ts';
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
