import { describe, expect, test } from 'bun:test';
import { claimConflicts, launchCommand, outOfScope, parseBrief, parseCodexUsage, pathsOverlap, rangesOverlap, SONNET_MODEL,
  type Task, usageLevel, validateBrief } from './goalctl.ts';

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

  test('rejects efforts the engine does not accept, absolute or .temp paths and malformed ranges', () => {
    const parsed = parseBrief(brief.replace('xhigh', 'ultra').replace('services/main/src/modules/poll/**', '/etc/**')
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
    expect(pathsOverlap('services/**/poll.ts', 'services/main/src/app.ts')).toBe(false);
    expect(pathsOverlap('apps/web/app/identity/**', 'apps/web/app/[[]locale]/studio/**')).toBe(false);
    expect(pathsOverlap('apps/web/app/\\[locale\\]/studio/**', 'apps/web/app/[[]locale]/studio/page.tsx')).toBe(true);
    expect(pathsOverlap('apps/web/app/[[]locale]/w/**', 'apps/web/app/[[]locale]/studio/**')).toBe(false);
    expect(pathsOverlap('apps/web/app/[a-z]*/**', 'apps/web/app/identity/**')).toBe(true);
    expect(pathsOverlap('services/**/poll.ts', 'services/main/src/poll.ts')).toBe(true);
    expect(pathsOverlap('services/main/src/modules/*/outbox-event*.ts',
      'services/main/src/modules/content-publication/comment.ts')).toBe(false);
    expect(pathsOverlap('services/main/src/modules/*/outbox-event*.ts',
      'services/main/src/modules/work/outbox-event.ts')).toBe(true);
    expect(pathsOverlap('services/main/tests/*integration.test.ts', 'services/main/tests/member-reply*.ts')).toBe(true);
    expect(pathsOverlap('model/definitions/**', 'model/definitions/work-metadata*.ts')).toBe(true);
    expect(pathsOverlap('tests/qa/unit/*-resolution.test.ts', 'tests/qa/unit/core.test.ts')).toBe(false);
    expect(pathsOverlap('apps/web/app/w/**', 'apps/web/app/works/**')).toBe(false);
    expect(pathsOverlap('apps/web/**', 'apps/web/app/w/page.tsx')).toBe(true);
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

  test('paces dispatch against the time left before the 5h reset', () => {
    const now = 1_800_000_000;
    const snap = (used: number, resetIn: number, week?: number) => ({ at: now, rate_limits: {
      five_hour: { used_percentage: used, resets_at: now + resetIn },
      seven_day: week === undefined ? null : { used_percentage: week, resets_at: now + 3 * 86400 } } });
    // 80% after 4h (20%/h) with 1h left projects exactly 100%: no new dispatch.
    expect(usageLevel(snap(80, 3600), now * 1000).level).toBe('restricted');
    // 80% with 15 min left (about 17%/h) projects 84%: keep using the window.
    expect(usageLevel(snap(80, 900), now * 1000)).toMatchObject({ level: 'normal', projected: 84 });
    // A slower recent slope (width already reduced) reopens dispatch with the same used percentage.
    const resets = now + 3600;
    const history = [{ at: now - 1200, used: 76, resets }];
    expect(usageLevel(snap(80, 3600), now * 1000, history)).toMatchObject({ level: 'normal', projected: 92 });
    // 50% after 1h projects 250%: stop early instead of waiting for 80%.
    expect(usageLevel(snap(50, 4 * 3600), now * 1000).level).toBe('restricted');
    expect(usageLevel(snap(96, 60), now * 1000).level).toBe('critical');
    // The weekly window stops new Claude work when it would pass the cap's margin before its reset:
    // under the default 50% cap, 30% after 4 days projects about 53%.
    expect(usageLevel(snap(10, 4 * 3600, 30), now * 1000)).toMatchObject({ level: 'restricted' });
    expect(usageLevel(snap(10, 4 * 3600, 45), now * 1000)).toMatchObject({ level: 'critical' });
  });

  test('advises widening Claude work while the week would end unspent', () => {
    const now = 1_800_000_000;
    const weekResets = now + 24 * 3600;
    const snap = (week: number) => ({ at: now, rate_limits: {
      five_hour: { used_percentage: 10, resets_at: now + 4 * 3600 },
      seven_day: { used_percentage: week, resets_at: weekResets } } });
    // 24% after six days lands near 28%: spend more.
    expect(usageLevel(snap(24), now * 1000)).toMatchObject({ level: 'normal', weekProjected: 28 });
    expect(usageLevel(snap(24), now * 1000).weekAdvice).toContain('widen');
    // A recent slope of 3.5%/h over the last two hours lands at 24 + 84 = 108%: stop new Claude work.
    const history = [{ at: now - 7200, used: 5, resets: now + 4 * 3600, week: 17, weekResets }];
    expect(usageLevel(snap(24), now * 1000, history)).toMatchObject({ level: 'restricted', weekProjected: 108 });
  });

  test('reads a Codex account usage from its newest rollout line', () => {
    const now = 1_790_520_000_000;
    const line = (used: number, resets: number, reached: string | null = null) => JSON.stringify({
      timestamp: '2026-09-27T14:36:48.837Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: {
        primary: { used_percent: used, window_minutes: 10080, resets_at: resets }, secondary: null,
        plan_type: 'pro', rate_limit_reached_type: reached } } });
    const text = [line(40, 1_791_053_423), '{"type":"event_msg"}', line(45, 1_791_053_423), '{"partial'].join('\n');
    expect(parseCodexUsage(text, now)).toMatchObject({ used: 45, windowMinutes: 10080, plan: 'pro', reached: false,
      resetInHours: 148.2 });
    expect(parseCodexUsage(line(100, 1_791_053_423), now).reached).toBe(true);
    expect(parseCodexUsage(line(80, 1_790_000_000), now)).toMatchObject({ used: 0, reached: false });
    expect(parseCodexUsage('', now)).toEqual({});
  });

  test('pins the Opus model, effort and bypass permission mode without inbound session messages', () => {
    const [program, args] = launchCommand({ id: 'G-040', effort: 'medium', session: 's', prompt: 'p', resume: false });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'medium',
      '--dangerously-skip-permissions', '--session-id', 's', '-n', 'g-040']));
    expect(args.join(' ')).not.toContain('crossSessionInbound');
    expect(launchCommand({ id: 'G-040', effort: 'high', session: 's', prompt: 'p', resume: true })[1])
      .toEqual(expect.arrayContaining(['--resume', 's']));
  });

  test('runs Fable through Claude Code with its own model and a named session', () => {
    const [program, args] = launchCommand({ id: 'G-041', effort: 'xhigh', session: 's', prompt: 'p', resume: false,
      engine: 'fable' });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-fable-5-1', '--effort', 'xhigh',
      '--session-id', 's', '-n', 'g-041']));
  });

  test('runs Sonnet through Claude Code with its own model and a named session', () => {
    const [program, args] = launchCommand({ id: 'G-042', effort: 'high', session: 's', prompt: 'p', resume: false,
      engine: 'sonnet' });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', SONNET_MODEL, '--effort', 'high',
      '--session-id', 's', '-n', 'g-042']));
  });

  test('pins GPT-6.1 Sol and the reasoning effort for Codex workers in their worktree', () => {
    const [program, args] = launchCommand({ id: 'G-081', effort: 'xhigh', session: '', prompt: 'p', resume: false,
      engine: 'codex', worktree: '/w', lastMessage: '/r/last.md' });
    expect(program).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh',
      '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', '/r/last.md', '-C', '/w']));
    expect(launchCommand({ id: 'G-081', effort: 'high', session: 't', prompt: 'p', resume: true, engine: 'codex' })[1]
      .slice(0, 3)).toEqual(['exec', 'resume', 't']);
  });

  test('runs Sol on the second Codex account with the same flags; its account is chosen by environment', () => {
    const [program, args] = launchCommand({ id: 'G-101', effort: 'max', session: '', prompt: 'p', resume: false,
      engine: 'codex-1', worktree: '/w', lastMessage: '/r/a.md' });
    expect(program).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=max', '-C', '/w']));
  });

  test('runs Grok 4.7 through Cursor Agent with the effort in the model ID', () => {
    const [program, args] = launchCommand({ id: 'G-102', effort: 'xhigh', session: 'c', prompt: 'p', resume: true,
      engine: 'cursor', worktree: '/w' });
    expect(program).toBe('cursor-agent');
    expect(args).toEqual(expect.arrayContaining(['-p', 'p', '--model', 'grok-4.7-xhigh', '--force', '--trust',
      '--output-format', 'json', '--workspace', '/w', '--resume', 'c']));
  });

  test('pins GPT-6 Luna through Codex and Grok 4.7 in bypass mode for simpler workers', () => {
    const luna = launchCommand({ id: 'G-094', effort: 'high', session: '', prompt: 'p', resume: false,
      engine: 'luna', worktree: '/w', lastMessage: '/r/l.md' });
    expect(luna[0]).toBe('codex');
    expect(luna[1]).toEqual(expect.arrayContaining(['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high']));
    const [program, args] = launchCommand({ id: 'G-095', effort: 'high', session: 's', prompt: 'p', resume: true,
      engine: 'grok', worktree: '/w' });
    expect(program).toBe('grok');
    expect(args).toEqual(expect.arrayContaining(['-m', 'grok-4.7', '--permission-mode', 'bypassPermissions',
      '--no-subagents', '--output-format', 'json', '--cwd', '/w', '-r', 's']));
  });

  test('accepts the efforts each engine supports and rejects unknown engines', () => {
    const brief = (engine: string, effort: string) =>
      parseBrief(`---\nid: G-081\ntitle: t\neffort: ${effort}\nengine: ${engine}\n---\n`);
    expect(validateBrief(brief('codex', 'ultra'))).toEqual([]);
    expect(validateBrief(brief('claude', 'max'))).toEqual([]);
    expect(validateBrief(brief('fable', 'max'))).toEqual([]);
    expect(validateBrief(brief('sonnet', 'max'))).toEqual([]);
    expect(validateBrief(brief('codex-1', 'ultra'))).toEqual([]);
    expect(validateBrief(brief('astra', 'high')).join()).toContain('engine must be one of');
    expect(validateBrief(brief('cursor', 'xhigh'))).toEqual([]);
    expect(validateBrief(brief('luna', 'ultra')).join()).toContain('luna effort');
    expect(validateBrief(brief('grok', 'xhigh')).join()).toContain('grok effort');
    expect(validateBrief(brief('gemini', 'high')).join()).toContain('engine must be one of');
  });
});
