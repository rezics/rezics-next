import { describe, expect, test } from 'bun:test';
import { claimConflicts, launchCommand, outOfScope, parseBrief, pathsOverlap, rangesOverlap, type Task,
  usageLevel, validateBrief } from './goalctl.ts';

const brief = `---
id: G-040
title: Poll ballot owner schema  # comment
effort: xhigh
cases: [GOV11, GOV12]
paths: [services/main/src/modules/poll/**, tests/qa/integration/poll-*.test.ts]
migrations: [main/access:040-044]
shared: [route:poll]
depends: [G-038]
---
Body.
`;

function held(overrides: Partial<Task>): Task {
  return { id: 'G-039', title: 'held', effort: 'medium', cases: [], paths: [], migrations: [], shared: [],
    depends: [], brief: '', worktree: '', branch: '', base: '', state: 'running', attempts: [], ...overrides };
}

describe('goalctl briefs', () => {
  test('parses frontmatter lists and strips comments', () => {
    const parsed = parseBrief(brief);
    expect(parsed).toMatchObject({ id: 'G-040', title: 'Poll ballot owner schema', effort: 'xhigh',
      cases: ['GOV11', 'GOV12'], migrations: ['main/access:040-044'], shared: ['route:poll'], depends: ['G-038'] });
    expect(validateBrief(parsed)).toEqual([]);
  });

  test('rejects max effort, absolute or .temp paths and malformed ranges', () => {
    const parsed = parseBrief(brief.replace('xhigh', 'max').replace('services/main/src/modules/poll/**', '/etc/**')
      .replace('040-044', '044-040'));
    expect(validateBrief(parsed)).toHaveLength(3);
    expect(validateBrief({ ...parseBrief(brief), paths: ['.temp/x'] })).toHaveLength(1);
  });
});

describe('goalctl claims', () => {
  const parsed = parseBrief(brief);

  test('detects case, path, migration and shared-slot overlap with holding tasks only', () => {
    const conflicts = claimConflicts(parsed, [
      held({ cases: ['GOV12'], paths: ['tests/qa/integration/poll-tally.test.ts'],
        migrations: ['main/access:044-046'], shared: ['route:poll'] }),
      held({ id: 'G-030', cases: ['GOV11'], state: 'verified' }),
    ]);
    expect(conflicts).toHaveLength(4);
    expect(conflicts.join('\n')).not.toContain('G-030');
  });

  test('keeps disjoint claims independent', () => {
    expect(claimConflicts(parsed, [held({ cases: ['GOV13'], paths: ['services/main/src/modules/poll.ts'],
      migrations: ['main/access:045-049', 'content:040-044'] })])).toEqual([]);
    expect(pathsOverlap('tests/qa/integration/poll-*', 'tests/qa/integration/pkg-*')).toBe(false);
    expect(pathsOverlap('services/**/poll.ts', 'services/main/src/app.ts')).toBe(true);
    expect(rangesOverlap('content:001-003', 'content:003-009')).toBe(true);
  });

  test('reports changed files outside the claimed globs', () => {
    expect(outOfScope(['services/main/src/modules/poll/ballot.ts', 'services/main/src/app.ts'],
      parsed.paths)).toEqual(['services/main/src/app.ts']);
  });
});

describe('goalctl runtime policy', () => {
  test('classifies 5h usage and treats stale snapshots as unknown', () => {
    const now = 1_800_000_000_000;
    const at = now / 1000 - 60;
    expect(usageLevel({ at, rate_limits: { five_hour: { used_percentage: 42 } } }, now).level).toBe('normal');
    expect(usageLevel({ at, rate_limits: { five_hour: { used_percentage: 80 } } }, now).level).toBe('restricted');
    expect(usageLevel({ at, rate_limits: { five_hour: { used_percentage: 97 } } }, now).level).toBe('critical');
    expect(usageLevel({ at: at - 3600, rate_limits: { five_hour: { used_percentage: 97 } } }, now).level)
      .toBe('unknown');
    expect(usageLevel(undefined, now).level).toBe('unknown');
  });

  test('pins the Opus model, effort and auto permission mode without inbound session messages', () => {
    const [program, args] = launchCommand({ id: 'G-040', effort: 'medium', session: 's', prompt: 'p', resume: false });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'medium',
      '--permission-mode', 'auto', '--session-id', 's', '-n', 'g-040']));
    expect(args.join(' ')).not.toContain('crossSessionInbound');
    expect(launchCommand({ id: 'G-040', effort: 'high', session: 's', prompt: 'p', resume: true })[1])
      .toEqual(expect.arrayContaining(['--resume', 's']));
  });
});
