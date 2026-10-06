import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { acquireHeavy, archiveFiles, areaConflicts, briefFile, claimConflicts, migrationsBelowMain, compositionSyntaxFailure, goalAreas,
  goalOfBriefPath, heavyQaStatus, historyIntroductions, isHeavyTest, landedBoundary, launchCommand, nextTaskId, normalizeUseChains, outOfScope, ownerRefusal,
  parseBrief, parseCodexUsage, pathsOverlap, prepareCompositionMerge, preserveWorktreeArtifacts, rangesOverlap, removeFromTree, SONNET_MODEL,
  type Ledger, type Task, treeMentions, usageLevel, validateBrief } from './goalctl.ts';

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

  test('a branch may not add migrations numbered below main', () => {
    const main = () => ['985_a.sql', '1004_b.sql'];
    expect(migrationsBelowMain(['services/main/migrations/access/990_x.sql'], main))
      .toEqual(['services/main/migrations/access/990_x.sql (main already has 1004)']);
    expect(migrationsBelowMain(['services/main/migrations/access/1010_x.sql', 'apps/web/a.ts'], main)).toEqual([]);
  });

  test('Codex workers run on the service tier the manager selects', () => {
    const previous = process.env.GOAL_CODEX_SERVICE_TIER;
    try {
      for (const tier of ['fast', 'default']) {
        process.env.GOAL_CODEX_SERVICE_TIER = tier;
        const [, args] = launchCommand({ id: 'G-950', effort: 'high', session: '', prompt: 'p', engine: 'codex',
          worktree: '/w' } as Parameters<typeof launchCommand>[0]);
        expect(args.join(' ')).toContain(`service_tier="${tier}"`);
      }
    } finally {
      if (previous === undefined) delete process.env.GOAL_CODEX_SERVICE_TIER;
      else process.env.GOAL_CODEX_SERVICE_TIER = previous;
    }
  });

  test('a brief may name a shared worktree; its brief file is per task', () => {
    const brief = parseBrief('---\nid: G-950\ntitle: t\neffort: high\nengine: codex\nworktree: wave-9\npaths: [a/**]\n---\n');
    expect(brief.worktree).toBe('wave-9');
    expect(validateBrief(brief)).toEqual([]);
    expect(validateBrief({ ...brief, worktree: '../x' })).toContain('worktree must be a lower-case name: ../x');
    expect(briefFile({ id: 'G-950', worktree: '/w', shared: true })).toBe('.temp/goal/brief-g-950.md');
    expect(briefFile({ id: 'G-950', worktree: '/w' })).toBe('.temp/goal/brief.md');
  });

  test('Next.js dynamic folders in claims are literal directories', () => {
    expect(pathsOverlap('apps/web/app/[locale]/[handle]/**', 'apps/web/app/[locale]/following/**')).toBe(false);
    expect(pathsOverlap('apps/web/app/[locale]/[handle]/**', 'apps/web/app/[locale]/[handle]/page.tsx')).toBe(true);
    expect(pathsOverlap('apps/web/app/[locale]/z/[[...path]]/**', 'apps/web/app/[locale]/z/**')).toBe(true);
    expect(pathsOverlap('apps/web/app/[locale]/r/[realm]/[...path]/**', 'apps/web/app/[locale]/r/[realm]/about/**')).toBe(false);
  });

  test('migration ranges compare numerically past 999', () => {
    expect(rangesOverlap('services/main/migrations/access:998-1002', 'services/main/migrations/access:1000-1003')).toBe(true);
    expect(rangesOverlap('services/main/migrations/access:990-999', 'services/main/migrations/access:1000-1003')).toBe(false);
  });

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
    // under the default 100% cap, 60% after 4 days projects 105%; 30% projects about 53% and continues.
    expect(usageLevel(snap(10, 4 * 3600, 60), now * 1000)).toMatchObject({ level: 'restricted' });
    expect(usageLevel(snap(10, 4 * 3600, 30), now * 1000)).toMatchObject({ level: 'normal' });
    expect(usageLevel(snap(10, 4 * 3600, 95), now * 1000)).toMatchObject({ level: 'critical' });
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

function gitShow(rev: string, path: string): string {
  const result = spawnSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe('goalctl composition merge', () => {
  const signatures = (source: string) => source.split('\n').filter(line => /^(export )?function /.test(line));

  test('normalizes the G-629 union chain without rewriting signatures', () => {
    // fdcb726e is the rebased app.ts goalctl then rewrote in ee678f81: realmAdminRoutes twice, a `;`
    // in the middle of the chain, and the mountedReads parameter still present.
    const input = gitShow('fdcb726e', 'services/main/src/app.ts');
    const broken = [
      '    .use(realmAdminRoutes(work));',
      '    .use(realmAdminRoutes(work))',
      '    .use(memberReplyRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads));',
    ].join('\n');
    const fixed = [
      '    .use(realmAdminRoutes(work))',
      '    .use(memberReplyRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads));',
    ].join('\n');
    expect(input).toContain(broken);
    expect(input).toContain('function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies, mountedReads: () => ReadonlySet<string>)');
    expect(compositionSyntaxFailure('services/main/src/app.ts', input)).toContain('services/main/src/app.ts');

    const decision = prepareCompositionMerge([{ file: 'services/main/src/app.ts', source: input }]);
    expect(decision.fastForward).toBe(true);
    expect(decision.files[0]!.source).toBe(input.replace(broken, fixed));
    expect(signatures(decision.files[0]!.source)).toEqual(signatures(input));
    expect(decision.files[0]!.source).toContain('.use(domainRoutes(fuseki, work, () => new Set(app.routes');
    expect(normalizeUseChains(decision.files[0]!.source)).toBe(decision.files[0]!.source);
    // ee678f81 is the normalization that dropped the parameter. That rewrite must not come back.
    const dropped = gitShow('ee678f81', 'services/main/src/app.ts');
    expect(dropped).toContain('function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {');
    expect(decision.files[0]!.source).not.toBe(dropped);
  });

  test('keeps .use() calls that differ and leaves a clean composition root unchanged', () => {
    const distinct = [
      'function domainRoutes(work: SearchRouteDependencies, mountedReads: () => ReadonlySet<string>) {',
      '  return new Elysia()',
      '    .use(entityPageRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads));',
      '}',
      '',
    ].join('\n');
    expect(normalizeUseChains(distinct)).toBe(distinct);
    const current = readFileSync('services/main/src/app.ts', 'utf8');
    expect(normalizeUseChains(current)).toBe(current);
    expect(prepareCompositionMerge([{ file: 'services/main/src/app.ts', source: current }]).fastForward).toBe(true);
  });

  test('refuses the merge when a composition root still does not parse', () => {
    const source = [
      'function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies, mountedReads: () => ReadonlySet<string>) {',
      '  return new Elysia()',
      '    .use(realmAdminRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads)',
      '}',
      '',
    ].join('\n');
    const decision = prepareCompositionMerge([{ file: 'services/main/src/app.ts', source }]);
    expect(decision.fastForward).toBe(false);
    expect(decision.state).toBe('conflict');
    expect(decision.error).toContain('services/main/src/app.ts');
    expect(decision.error).toMatch(/:\d+:\d+:/);
    expect(decision.files[0]!.source).toContain('mountedReads: () => ReadonlySet<string>');
    expect(signatures(decision.files[0]!.source)).toEqual(signatures(source));
  });
});

describe('goalctl close', () => {
  test('keeps a removed worktree\'s .temp artifacts beside the task run records', () => {
    const base = mkdtempSync(join(tmpdir(), 'goalctl-close-'));
    try {
      const worktree = join(base, 'wt'), runDir = join(base, 'runs', 'G-1');
      mkdirSync(join(worktree, '.temp', 'g-1'), { recursive: true });
      writeFileSync(join(worktree, '.temp', 'g-1', 'fix.patch'), 'patch');
      const first = preserveWorktreeArtifacts(worktree, runDir)!;
      expect(readFileSync(join(first, 'g-1', 'fix.patch'), 'utf8')).toBe('patch');
      expect(existsSync(join(worktree, '.temp'))).toBe(false);
      mkdirSync(join(worktree, '.temp'), { recursive: true });
      const second = preserveWorktreeArtifacts(worktree, runDir)!;
      expect(second).not.toBe(first);
      expect(preserveWorktreeArtifacts(worktree, runDir)).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('goalctl Goals', () => {
  test('a brief belongs to the Goal whose directory holds it; the pre-Goal tasks directory has none', () => {
    expect(goalOfBriefPath('docs/goals/addresses-discovery/tasks/G-1065.md')).toBe('addresses-discovery');
    expect(goalOfBriefPath('docs/goals/tasks/G-1064.md')).toBeUndefined();
    expect(goalOfBriefPath('docs/goals/tasks/tasks/G-1064.md')).toBeUndefined();
    expect(goalOfBriefPath('docs/goals/addresses-discovery/GOAL.md')).toBeUndefined();
  });

  test('another active Goal\'s areas refuse a claim; the own Goal\'s and unowned paths do not', () => {
    const areas = { discovery: goalAreas('---\nareas: [services/main/src/modules/discovery/**, apps/web/features/discover/**]\n---\n# Goal\n'),
      production: [] };
    expect(areas.discovery).toEqual(['services/main/src/modules/discovery/**', 'apps/web/features/discover/**']);
    expect(areaConflicts(['services/main/src/modules/discovery/read.ts'], 'production', areas))
      .toEqual(['path services/main/src/modules/discovery/read.ts lies in Goal discovery\'s area services/main/src/modules/discovery/**']);
    expect(areaConflicts(['apps/web/features/**'], 'production', areas)).toHaveLength(1);
    expect(areaConflicts(['services/main/src/modules/discovery/**'], 'discovery', areas)).toEqual([]);
    expect(areaConflicts(['services/main/src/modules/poll/**'], 'production', areas)).toEqual([]);
    expect(goalAreas('# A Goal without frontmatter\n')).toEqual([]);
    expect(goalAreas('---\n# areas: other Goals keep out\nareas:\n  - services/main/src/modules/feed/**  # the feeds\n  - apps/web/features/shell/**\n---\n'))
      .toEqual(['services/main/src/modules/feed/**', 'apps/web/features/shell/**']);
  });

  test('IDs continue after every used, reserved and archived number', () => {
    expect(nextTaskId(['G-1063', 'G-999', 'G-040', 'notes'], 1064)).toBe('G-1065');
    expect(nextTaskId(['G-1066'], 1064)).toBe('G-1067');
    expect(nextTaskId([])).toBe('G-001');
  });

  test('a manager may change only its own Goal\'s tasks', () => {
    expect(ownerRefusal({ id: 'G-1065', goal: 'discovery' }, 'production')).toContain('belongs to Goal discovery');
    expect(ownerRefusal({ id: 'G-1065', goal: 'discovery' }, 'discovery')).toBeUndefined();
    const goal = process.env.GOAL_ID;
    delete process.env.GOAL_ID;
    try { expect(ownerRefusal({ id: 'G-1065', goal: 'discovery' })).toBeUndefined(); }
    finally { if (goal === undefined) delete process.env.GOAL_ID; else process.env.GOAL_ID = goal; }
    expect(ownerRefusal({ id: 'G-900' }, 'production')).toBeUndefined();
  });

  test('affected sets, whole tiers and --heavy runs are heavy; explicit files and plans are not', () => {
    expect(isHeavyTest(['--affected'])).toBe(true);
    expect(isHeavyTest(['--affected=main~3'])).toBe(true);
    expect(isHeavyTest(['--tier', 'integration'])).toBe(true);
    expect(isHeavyTest(['--heavy', 'tests/qa/integration/a.test.ts'])).toBe(true);
    expect(isHeavyTest(['--affected', '--list'])).toBe(false);
    expect(isHeavyTest(['tests/qa/integration/a.test.ts'])).toBe(false);
  });
});

describe('goalctl reclaim', () => {
  interface LedgerFile { tasks: Record<string, { paths: string[]; brief: string }> }

  /** Two active Goals and an exited task whose brief can be replaced without a worktree. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-reclaim-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    mkdirSync(join(dir, 'docs/goals/alpha'), { recursive: true });
    mkdirSync(join(dir, 'docs/goals/beta'), { recursive: true });
    writeFileSync(join(dir, 'docs/goals/alpha/GOAL.md'),
      '---\nareas: [services/main/src/modules/alpha/**]\n---\n# Alpha\n');
    writeFileSync(join(dir, 'docs/goals/beta/GOAL.md'),
      '---\nareas: [services/main/src/modules/beta/**]\n---\n# Beta\n');
    const task = (id: string, goal: string, paths: string[], state: string) => ({
      id, title: id, effort: 'high', engine: 'grok', cases: [], paths, migrations: [], shared: [],
      depends: [], brief: join(dir, `${id}.md`), worktree: join(dir, 'absent-worktree'),
      branch: `goal/${id.toLowerCase()}`, base: '0', state, attempts: [], goal,
    });
    const ledger = {
      goals: {
        alpha: { manager: 'alpha-manager', startedAt: '2026-10-05T00:00:00.000Z' },
        beta: { manager: 'beta-manager', startedAt: '2026-10-05T00:00:00.000Z' },
      },
      tasks: {
        'G-010': task('G-010', 'alpha', ['services/main/src/modules/alpha/read.ts'], 'exited'),
        'G-011': task('G-011', 'beta', ['services/main/src/modules/beta/held.ts'], 'running'),
      },
    };
    mkdirSync(join(dir, '.temp/goal-orchestration'), { recursive: true });
    writeFileSync(join(dir, '.temp/goal-orchestration/ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
    return dir;
  }

  function writeBrief(dir: string, paths: string): string {
    const path = join(dir, 'brief.md');
    writeFileSync(path, ['---', 'id: G-010', 'title: Alpha work', 'effort: high', 'engine: grok', 'cases: []',
      `paths: [${paths}]`, 'migrations: []', 'shared: []', 'depends: []', '---', '', 'Outcome.', ''].join('\n'));
    return path;
  }

  function run(dir: string, args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_ID: 'alpha' };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_INDEX_FILE;
    return spawnSync('bun', [join(import.meta.dir, 'goalctl.ts'), ...args], { cwd: dir, encoding: 'utf8', env });
  }

  function ledgerOf(dir: string): LedgerFile {
    return JSON.parse(readFileSync(join(dir, '.temp/goal-orchestration/ledger.json'), 'utf8')) as LedgerFile;
  }

  test('refuses a path in another Goal\'s area without --allow-area', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/beta/read.ts');
      const result = run(dir, ['reclaim', 'G-010', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'path services/main/src/modules/beta/read.ts lies in Goal beta\'s area services/main/src/modules/beta/**');
      expect(ledgerOf(dir).tasks['G-010']!.paths).toEqual(['services/main/src/modules/alpha/read.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('accepts another Goal\'s area when --allow-area is set', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/beta/read.ts');
      const result = run(dir, ['reclaim', 'G-010', path, '--allow-area']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('G-010 claims replaced');
      const task = ledgerOf(dir).tasks['G-010']!;
      expect(task.paths).toEqual(['services/main/src/modules/beta/read.ts']);
      expect(task.brief).toBe(path);
      expect(ledgerOf(dir).tasks['G-011']!.paths).toEqual(['services/main/src/modules/beta/held.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('still refuses a claim overlap with another open task when --allow-area is set', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/beta/held.ts');
      const result = run(dir, ['reclaim', '--allow-area', 'G-010', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'path services/main/src/modules/beta/held.ts overlaps G-011 services/main/src/modules/beta/held.ts');
      expect(result.stderr).not.toContain('lies in Goal');
      expect(ledgerOf(dir).tasks['G-010']!.paths).toEqual(['services/main/src/modules/alpha/read.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('still replaces a claim inside the task\'s own area without the flag', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/alpha/next.ts');
      const result = run(dir, ['reclaim', 'G-010', path]);
      expect(result.status).toBe(0);
      expect(ledgerOf(dir).tasks['G-010']!.paths).toEqual(['services/main/src/modules/alpha/next.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('lists --allow-area beside reclaim in the usage text', () => {
    const result = spawnSync('bun', [join(import.meta.dir, 'goalctl.ts')], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('reclaim <id> <brief> [--allow-area]');
    expect(result.stderr).toContain('dispatch <brief.md> [--dry-run] [--force-usage] [--allow-area]');
  });
});

describe('goalctl shared lifecycle and launch gates', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-lifecycle-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'goal@example.invalid');
    git('config', 'user.name', 'goalctl test');
    mkdirSync(join(dir, 'scripts/goal'), { recursive: true });
    copyFileSync(join(import.meta.dir, 'dedupe-imports.ts'), join(dir, 'scripts/goal/dedupe-imports.ts'));
    for (const root of ['app.ts', 'index.ts', 'routes/dependencies.ts']) {
      mkdirSync(join(dir, 'services/main/src/routes'), { recursive: true });
      writeFileSync(join(dir, 'services/main/src', root), 'export {};\n');
    }
    writeFileSync(join(dir, '.gitignore'), '.temp/\n');
    git('add', '.');
    git('commit', '-qm', 'start');
    mkdirSync(join(dir, '.temp/bin'), { recursive: true });
    const fixture = join(import.meta.dir, 'fixtures/sleep-worker.ts');
    for (const binary of ['grok', 'claude', 'codex', 'codex-1']) {
      writeFileSync(join(dir, '.temp/bin', binary), `#!/usr/bin/env bun\nimport ${JSON.stringify(fixture)};\n`);
      chmodSync(join(dir, '.temp/bin', binary), 0o755);
    }
    writeFileSync(join(dir, '.temp/bin/corepack'), '#!/bin/sh\nexit 0\n');
    for (const binary of ['grok', 'corepack']) chmodSync(join(dir, '.temp/bin', binary), 0o755);
    const ready = join(dir, '.temp/ready');
    mkdirSync(ready);
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_ID: 'alpha', GOAL_MAX_WORKERS: '25',
      GOAL_CODEX_HOME: join(dir, '.temp/codex'), GOAL_CODEX_1_HOME: join(dir, '.temp/codex-1'),
      GOAL_USAGE_FILE: join(dir, '.temp/usage.json'), GOAL_SLEEP_READY_DIR: ready,
      PATH: `${join(dir, '.temp/bin')}:${process.env.PATH}` };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    const ledgerPath = join(dir, '.temp/goal-orchestration/ledger.json');
    const ledger = (): Ledger => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
    const save = (value: Ledger) => writeFileSync(ledgerPath, JSON.stringify(value));
    const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync('bun',
      [join(import.meta.dir, 'goalctl.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...overrides }, timeout: 45_000 });
    for (const goal of ['alpha', 'beta']) {
      mkdirSync(join(dir, 'docs/goals', goal), { recursive: true });
      writeFileSync(join(dir, 'docs/goals', goal, 'GOAL.md'), '---\nareas: []\n---\n');
      expect(run(['goal', 'start', goal, '--manager', `${goal}-manager`], { GOAL_ID: goal }).status).toBe(0);
    }
    git('add', '.');
    git('commit', '-qm', 'Goals');
    const brief = (id: string, options: { worktree?: string; depends?: string; engine?: string } = {}) => {
      const path = join(dir, '.temp', `${id}.md`);
      writeFileSync(path, ['---', `id: ${id}`, 'title: Sleeping test worker', 'effort: high',
        `engine: ${options.engine ?? 'grok'}`, `paths: [worker-${id.slice(2)}.ts]`, `depends: [${options.depends ?? ''}]`,
        ...options.worktree ? [`worktree: ${options.worktree}`] : [], '---', ''].join('\n'));
      return path;
    };
    const workers = new Map<string, { worker: number; child: number }>();
    const start = async (id: string, goal = 'alpha', worktree?: string) => {
      const result = run(['dispatch', brief(id, { worktree })], { GOAL_ID: goal });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const deadline = Date.now() + 5000;
      while (!existsSync(join(ready, id)) && Date.now() < deadline) await Bun.sleep(20);
      const pids = JSON.parse(readFileSync(join(ready, id), 'utf8')) as { worker: number; child: number };
      workers.set(id, pids);
      return ledger().tasks[id]!;
    };
    const alive = (pid: number) => {
      try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; }
      catch { return false; }
    };
    const stopFixture = async (id: string) => {
      const pids = workers.get(id)!;
      for (const pid of [pids.worker, pids.child]) { try { process.kill(pid, 'SIGTERM'); } catch { /* exited */ } }
      const deadline = Date.now() + 5000;
      while ([pids.worker, pids.child].some(alive) && Date.now() < deadline) await Bun.sleep(20);
      const value = ledger();
      value.tasks[id]!.state = 'exited';
      save(value);
    };
    const commit = (task: Task, path = `worker-${task.id.slice(2)}.ts`) => {
      writeFileSync(join(task.worktree, path), `export const value = '${task.id.slice(2)}';\n`);
      const result = spawnSync('git', ['-C', task.worktree, 'add', path], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', `Deliver ${task.id}`]).status).toBe(0);
    };
    const cleanup = () => {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`GOAL_SLEEP_READY_DIR=${ready}`)) {
            process.kill(Number(entry), 'SIGKILL');
          }
        } catch { /* exited */ }
      }
      for (const { worker, child } of workers.values()) {
        for (const pid of [worker, child]) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
      }
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, git, env, run, ledger, save, brief, start, workers, alive, stopFixture, commit, cleanup };
  }

  test('stop preserves a live sharer, its detached children, commits and shared stack', async () => {
    const r = repo();
    let server: ChildProcess | undefined;
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      const second = await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first);
      r.commit(second);
      const head = r.git('rev-parse', first.branch);
      const env = { ...r.env };
      delete env.GOAL_TASK_ID;
      server = spawn('bun', [join(import.meta.dir, 'fixtures/sleep-worker.ts'), '--child'],
        { cwd: first.worktree, detached: true, stdio: 'ignore', env });
      const dockerLog = join(r.dir, '.temp/docker.log');
      writeFileSync(join(r.dir, '.temp/bin/docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dockerLog}'\necho container\n`);
      chmodSync(join(r.dir, '.temp/bin/docker'), 0o755);
      expect(r.run(['stop', first.id]).status).toBe(0);
      await Bun.sleep(100);
      expect(r.alive(r.workers.get(first.id)!.worker)).toBe(false);
      expect(r.alive(r.workers.get(first.id)!.child)).toBe(false);
      expect(r.alive(r.workers.get(second.id)!.worker)).toBe(true);
      expect(r.alive(r.workers.get(second.id)!.child)).toBe(true);
      expect(r.alive(server.pid!)).toBe(true);
      expect(existsSync(dockerLog)).toBe(false);
      expect(r.git('rev-parse', first.branch)).toBe(head);
      expect(r.ledger().tasks[first.id]!.state).toBe('stopped');
      expect(r.run(['stop', second.id]).status).toBe(0);
      await Bun.sleep(100);
      expect(r.alive(server.pid!)).toBe(false);
      expect(readFileSync(dockerLog, 'utf8')).toContain(`compose -p rezics-qa-wt-${second.worktree.split('/').at(-1)} down -v`);
    } finally { server?.kill('SIGKILL'); r.cleanup(); }
  }, 30_000);

  test('merges the shared branch once, accepts both claims and records all open sharers', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      const second = await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first);
      r.commit(second);
      await r.stopFixture(first.id);
      await r.stopFixture(second.id);
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', first.id]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const tasks = r.ledger().tasks;
      expect(tasks[first.id]!.state).toBe('merged');
      expect(tasks[second.id]!.state).toBe('merged');
      expect(tasks[first.id]!.mergedCommit).toBe(r.git('rev-parse', 'main'));
      expect(tasks[second.id]!.mergedCommit).toBe(tasks[first.id]!.mergedCommit);
      const events = () => readFileSync(join(r.dir, '.temp/goal-orchestration/merges.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(events()).toEqual([{ before, after: tasks[first.id]!.mergedCommit, goal: 'alpha',
        taskIds: [first.id, second.id], at: expect.any(String) }]);
      expect(r.run(['merge', second.id]).status).toBe(0);
      // A resumed sharer may finish without new commits; the no-op merge still records its delivered work.
      await r.stopFixture(second.id);
      expect(r.run(['merge', first.id]).status).toBe(0);
      expect(r.ledger().tasks[second.id]!.state).toBe('merged');
      expect(r.ledger().tasks[second.id]!.mergedCommit).toBe(tasks[first.id]!.mergedCommit);
      expect(events()).toHaveLength(1);
    } finally { r.cleanup(); }
  }, 30_000);

  test('a manually landed cherry-pick records its boundary and preserves intervening maintainer commits', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      r.commit(task); await r.stopFixture(task.id);
      writeFileSync(join(r.dir, 'maintainer.ts'), 'export {};\n');
      r.git('add', 'maintainer.ts'); r.git('commit', '-qm', 'Maintainer edit');
      const before = r.git('rev-parse', 'main');
      r.git('cherry-pick', task.branch);
      const after = r.git('rev-parse', 'main');
      expect(r.run(['merge', task.id, '--landed']).status).toBe(0);
      const path = join(r.dir, '.temp/goal-orchestration/merges.jsonl');
      expect(JSON.parse(readFileSync(path, 'utf8').trim())).toMatchObject({ before, after, goal: 'alpha', taskIds: [task.id] });
      expect(r.run(['merge', task.id, '--landed']).status).toBe(0);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { r.cleanup(); }
  }, 30_000);

  test('inbox lists, acknowledges a displayed line and status prints the unacknowledged count', () => {
    const r = repo();
    try {
      const dir = join(r.dir, '.temp/goal-orchestration/inbox'); mkdirSync(dir);
      const entry = { runId: 'run', atCommit: 'sha', failingTests: ['file'], after: 'sha', goal: 'alpha', taskIds: [],
        status: 'inconclusive', classification: 'deterministic', artifactPaths: [] };
      writeFileSync(join(dir, 'alpha.jsonl'), `${JSON.stringify(entry)}\n`);
      expect(r.run(['status']).stdout).toContain('1 unacknowledged regressions');
      expect(JSON.parse(r.run(['inbox']).stdout.trim())).toMatchObject({ number: 1, acknowledged: false });
      expect(r.run(['inbox', '--ack', '1']).status).toBe(0);
      expect(JSON.parse(r.run(['inbox']).stdout.trim())).toMatchObject({ acknowledged: true });
      expect(r.run(['inbox', '--ack', '2']).status).toBe(1);
      expect(r.run(['status']).stdout).not.toContain('1 unacknowledged regressions');
    } finally { r.cleanup(); }
  });

  test('manual merge attribution preserves whitespace that changes a string value', () => {
    const r = repo();
    try {
      const base = r.git('rev-parse', 'HEAD');
      r.git('checkout', '-b', 'worker');
      writeFileSync(join(r.dir, 'value.ts'), "export const value = 'a b';\n");
      r.git('add', 'value.ts'); r.git('commit', '-qm', 'Worker');
      r.git('checkout', 'main');
      writeFileSync(join(r.dir, 'value.ts'), "export const value = 'ab';\n");
      r.git('add', 'value.ts'); r.git('commit', '-qm', 'Different maintainer value');
      const after = r.git('rev-parse', 'HEAD');
      expect(landedBoundary(r.dir, { base, branch: 'worker' }, after)).toBe(after);
    } finally { r.cleanup(); }
  });

  test('test records queue, test and total time and retains its first test argument', () => {
    const r = repo();
    try {
      mkdirSync(join(r.dir, 'scripts/qa'), { recursive: true });
      writeFileSync(join(r.dir, 'scripts/qa/test.ts'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.REGRESSION_ARGUMENTS!, JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(join(r.dir, '.temp/bin/docker'), '#!/bin/sh\nexit 0\n'); chmodSync(join(r.dir, '.temp/bin/docker'), 0o755);
      const report = join(r.dir, '.temp/result.json'); const args = join(r.dir, '.temp/args.json');
      expect(r.run(['test', 'example.test.ts', '--result-file', report], { REGRESSION_ARGUMENTS: args }).status).toBe(0);
      expect(JSON.parse(readFileSync(args, 'utf8'))).toEqual(['example.test.ts']);
      const result = JSON.parse(readFileSync(report, 'utf8'));
      expect(result.code).toBe(0);
      expect(result.totalMs).toBe(result.queueMs + result.testMs);
      expect(result.testMs).toBeGreaterThanOrEqual(0);
    } finally { r.cleanup(); }
  });

  test('refuses a shared merge while another sharer is running', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first);
      await r.stopFixture(first.id);
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', first.id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('G-002 is still running');
      expect(r.git('rev-parse', 'main')).toBe(before);
    } finally { r.cleanup(); }
  });

  test('refuses files outside every shared claim', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first, 'unclaimed.ts');
      await r.stopFixture(first.id);
      await r.stopFixture('G-002');
      const result = r.run(['merge', first.id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unclaimed.ts');
    } finally { r.cleanup(); }
  });

  test('two Goals naming wave-1 get different trees and branches', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      const second = await r.start('G-002', 'beta', 'wave-1');
      expect(first.worktree).toBe(join(r.dir, '.temp/worktrees/alpha-wave-1'));
      expect(second.worktree).toBe(join(r.dir, '.temp/worktrees/beta-wave-1'));
      expect(first.branch).toBe('goal/alpha-wave-1');
      expect(second.branch).toBe('goal/beta-wave-1');
    } finally { r.cleanup(); }
  });

  test('refuses joining a tree occupied by another Goal even when its worker has exited', async () => {
    const r = repo();
    try {
      await r.start('G-001', 'alpha', 'wave-1');
      await r.stopFixture('G-001');
      const value = r.ledger();
      value.tasks['G-001']!.goal = 'beta';
      r.save(value);
      const result = r.run(['dispatch', r.brief('G-002', { worktree: 'wave-1' }), '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('another Goal');
    } finally { r.cleanup(); }
  });

  test('dispatch refuses an unknown dependency with the cross-Goal contract location', () => {
    const r = repo();
    try {
      const result = r.run(['dispatch', r.brief('G-001', { depends: 'G-999' }), '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown dependency G-999');
      expect(result.stderr).toContain('docs/goals/program/state.md');
    } finally { r.cleanup(); }
  });

  test('resume checks the live-worker limit even with --force-usage', async () => {
    const r = repo();
    try {
      await r.start('G-001');
      await r.start('G-002');
      await r.stopFixture('G-001');
      for (const flags of [[], ['--force-usage']]) {
        const result = r.run(['resume', 'G-001', '-m', 'continue', ...flags], { GOAL_MAX_WORKERS: '1' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Concurrency limit reached: 1/1 live workers');
        expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(1);
      }
    } finally { r.cleanup(); }
  });

  test('resume checks the chosen engine usage and --force-usage overrides it', async () => {
    const r = repo();
    try {
      await r.start('G-001');
      await r.stopFixture('G-001');
      writeFileSync(r.env.GOAL_USAGE_FILE!, JSON.stringify({ at: Date.now() / 1000, rate_limits: {
        five_hour: { used_percentage: 100, resets_at: Date.now() / 1000 + 3600 } } }));
      for (const home of [r.env.GOAL_CODEX_HOME!, r.env.GOAL_CODEX_1_HOME!]) {
        const sessions = join(home, 'sessions/2026/10/07');
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', payload: {
          type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 10080,
            resets_at: Date.now() / 1000 + 3600 } } } }));
      }
      for (const engine of ['claude', 'sonnet', 'fable', 'codex', 'codex-1', 'luna']) {
        const result = r.run(['resume', 'G-001', '-m', 'continue', '--engine', engine]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(engine.startsWith('codex') || engine === 'luna' ? 'EXHAUSTED' : 'Claude usage is critical');
        expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(1);
      }
      // A fake Claude executable proves the escape reaches launch without calling a real engine.
      copyFileSync(join(r.dir, '.temp/bin/grok'), join(r.dir, '.temp/bin/claude'));
      const result = r.run(['resume', 'G-001', '-m', 'continue', '--engine', 'claude', '--force-usage']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const deadline = Date.now() + 5000;
      while (r.workers.get('G-001')!.worker === (JSON.parse(readFileSync(join(r.dir, '.temp/ready/G-001'), 'utf8')) as { worker: number }).worker
        && Date.now() < deadline) await Bun.sleep(20);
      r.workers.set('G-001', JSON.parse(readFileSync(join(r.dir, '.temp/ready/G-001'), 'utf8')) as { worker: number; child: number });
      expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(2);
    } finally { r.cleanup(); }
  });
});

describe('goalctl history gate', () => {
  test('refuses new task-named files and task IDs a file did not carry', () => {
    expect(historyIntroductions([
      { path: 'tests/qa/integration/g-1065-discover.test.ts', status: 'A', after: 'test()' },
      { path: 'apps/web/tests/g-1065/run.e2e.ts', status: 'A', after: '' },
      { path: 'services/main/src/modules/feed/read.ts', status: 'M', before: '// G-314 keeps it', after: '// G-314 keeps it\n// see G-1065' },
    ])).toEqual([
      'tests/qa/integration/g-1065-discover.test.ts: named after a task; name it by the capability it covers',
      'apps/web/tests/g-1065/run.e2e.ts: named after a task; name it by the capability it covers',
      'services/main/src/modules/feed/read.ts: adds G-1065; state the reason itself instead of citing the task',
    ]);
  });

  test('allows existing mentions to move, task-named files to be renamed and the Goal program to name tasks', () => {
    expect(historyIntroductions([
      { path: 'services/main/src/a.ts', status: 'M', before: 'x // G-314\ny', after: 'y\nx // G-314' },
      { path: 'tests/qa/integration/contribution-loop.test.ts', status: 'R', from: 'tests/qa/integration/g-704-contribution-loop.test.ts',
        before: "test('G-704 loop')", after: "test('G-704 loop')" },
      { path: 'tests/qa/integration/discovery/g-939-reads.test.ts', status: 'R', from: 'tests/qa/integration/g-939-reads.test.ts' },
      { path: 'docs/goals/production/tasks/G-1066.md', status: 'A', after: 'depends: [G-1065]' },
      { path: 'scripts/goal/goalctl.test.ts', status: 'M', before: '', after: "id: 'G-1065'" },
      { path: 'services/main/src/b.ts', status: 'D', before: 'G-1' },
      { path: 'assets/cover.png', status: 'A', after: 'PNG\0G-1065' },
      { path: 'apps/web/tests/agenda-1065.test.ts', status: 'A', after: 'GG-1065x' },
    ])).toEqual([]);
  });
});

describe('goalctl archive', () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-archive-test-'));
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'goal@example.invalid');
    run('config', 'user.name', 'goalctl test');
    mkdirSync(join(dir, 'docs/goals/g/tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs/goals/g/tasks/G-001.md'), 'brief');
    writeFileSync(join(dir, 'code.ts'), '// cites docs/goals/g/tasks/G-002.md\n');
    run('add', '.');
    run('commit', '-q', '-m', 'start');
    return dir;
  };
  const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();

  test('adds files to the orphan archive branch without moving HEAD and keeps earlier entries', () => {
    const dir = repo();
    try {
      const head = git(dir, 'rev-parse', 'HEAD');
      archiveFiles(dir, [{ path: 'g-2026-10-04/tasks/G-001.md', content: 'brief' }], 'Archive G-001');
      archiveFiles(dir, [{ path: 'g-2026-10-04/handoffs/G-001.md', content: 'handoff' }], 'Archive its handoff');
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(git(dir, 'ls-tree', '-r', '--name-only', 'archive/goals').split('\n'))
        .toEqual(['g-2026-10-04/handoffs/G-001.md', 'g-2026-10-04/tasks/G-001.md']);
      expect(git(dir, 'rev-list', '--count', 'archive/goals')).toBe('2');
      expect(git(dir, 'merge-base', 'main', 'archive/goals')).toBe('');
      expect(git(dir, 'status', '--porcelain')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('commits only the removed briefs and leaves what peers staged', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'peer.ts'), 'staged by a peer');
      git(dir, 'add', 'peer.ts');
      removeFromTree(dir, ['docs/goals/g/tasks/G-001.md'], 'Archive the closed brief G-001');
      expect(existsSync(join(dir, 'docs/goals/g'))).toBe(false);
      expect(existsSync(join(dir, 'docs'))).toBe(false);
      expect(git(dir, 'show', '--name-status', '--format=%s', 'HEAD').split('\n'))
        .toEqual(['Archive the closed brief G-001', '', 'D\tdocs/goals/g/tasks/G-001.md']);
      expect(git(dir, 'diff', '--cached', '--name-only')).toBe('peer.ts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('finds citations of a brief outside the excluded paths', () => {
    const dir = repo();
    try {
      expect(treeMentions(dir, ['docs/goals/g/tasks/G-002.md'], { exclude: ['docs/goals/**'] }))
        .toEqual(['code.ts:1:// cites docs/goals/g/tasks/G-002.md']);
      expect(treeMentions(dir, ['G-001'], { words: true })).toEqual([]);
      expect(treeMentions(dir, ['G-001'], { words: true, exclude: [] })).toEqual([]);
      expect(treeMentions(dir, [])).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('heavy QA lock', () => {
  const sixHours = 6 * 3_600_000;

  function unusedPid(): number {
    for (let pid = 2_000_000; pid < 2_001_000; pid++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('no unused pid');
  }

  function ticketRows(queueDir: string): [number, string | undefined, string | undefined, number][] {
    return readdirSync(queueDir).filter(name => name.endsWith('.json')).map(name => {
      const ticket = JSON.parse(readFileSync(join(queueDir, name), 'utf8')) as
        { pid: number; goal?: string; command?: string; arrivedAt: number };
      return [ticket.pid, ticket.goal, ticket.command, ticket.arrivedAt] as [number, string | undefined, string | undefined, number];
    }).sort((a, b) => a[3] - b[3] || a[0] - b[0]);
  }

  /** Pauses a waiter on each poll so the test can choose who looks at the lock next. */
  function gatedSleep() {
    const pending: Array<() => void> = [];
    let arm = () => {};
    return {
      next(): Promise<void> {
        return new Promise(resolve => { arm = resolve; });
      },
      sleep(): Promise<void> {
        return new Promise(resolve => {
          pending.push(resolve);
          arm();
        });
      },
      wake(): void {
        const resume = pending.shift();
        if (!resume) throw new Error('waiter is not sleeping');
        resume();
      },
    };
  }

  test('two heavy waiters are served in arrival order even when the earlier one polls later', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-order-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    const earlier = 1_010_101;
    const later = 2_020_202;
    const alive = (pid: number) => pid === earlier || pid === later || pid === process.pid;
    let clock = Date.now();
    const firstAt = clock;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    writeFileSync(join(lockDir, 'marker'), 'held');
    const first = gatedSleep();
    const second = gatedSleep();
    const served: string[] = [];
    const firstSlept = first.next();
    const firstDone = acquireHeavy(['first'], {
      lockDir, pid: earlier, goal: 'goal-a', now: () => clock, alive, bindExit: false, sleep: () => first.sleep(),
    }).then(release => { served.push('first'); return release; });
    const secondSlept = second.next();
    let secondDone: Promise<() => void> | undefined;
    try {
      expect(await Promise.race([
        firstSlept.then(() => 'slept' as const),
        firstDone.then(() => 'acquired' as const),
      ])).toBe('slept');
      expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('held');
      expect(existsSync(join(lockDir, 'info.json'))).toBe(false);
      clock = firstAt + 5;
      rmSync(lockDir, { recursive: true, force: true });
      secondDone = acquireHeavy(['second'], {
        lockDir, pid: later, goal: 'goal-b', now: () => clock, alive, bindExit: false, sleep: () => second.sleep(),
      }).then(release => { served.push('second'); return release; });
      expect(await Promise.race([
        secondSlept.then(() => 'slept' as const),
        secondDone.then(() => 'acquired' as const),
      ])).toBe('slept');
      expect(existsSync(lockDir)).toBe(false);
      expect(served).toEqual([]);
      expect(ticketRows(queueDir)).toEqual([
        [earlier, 'goal-a', 'first', firstAt],
        [later, 'goal-b', 'second', firstAt + 5],
      ]);
      first.wake();
      const releaseFirst = await firstDone;
      expect(served).toEqual(['first']);
      expect(ticketRows(queueDir)).toEqual([[later, 'goal-b', 'second', firstAt + 5]]);
      expect(JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf8'))).toMatchObject({
        pid: earlier, goal: 'goal-a', command: 'first',
      });
      releaseFirst();
      expect(existsSync(lockDir)).toBe(false);
      expect(existsSync(queueDir)).toBe(true);
      second.wake();
      const releaseSecond = await secondDone;
      expect(served).toEqual(['first', 'second']);
      expect(ticketRows(queueDir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf8')).pid).toBe(later);
      releaseSecond();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a dead heavy waiter\'s ticket does not block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-dead-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    const dead = unusedPid();
    mkdirSync(queueDir, { recursive: true });
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(dead));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);
    writeFileSync(join(queueDir, 'dead.json'), JSON.stringify({ pid: dead, goal: 'gone', command: 'old run', arrivedAt: 1 }));
    writeFileSync(join(queueDir, 'broken.json'), '{');
    writeFileSync(join(queueDir, 'partial.json'), JSON.stringify({ pid: process.pid, command: 'no arrival' }));
    try {
      const release = await acquireHeavy(['next'], {
        lockDir, pid: process.pid, goal: 'scoped-subjects', now: () => 2, bindExit: false,
        sleep: () => Promise.reject(new Error('waiter slept behind a dead ticket')),
      });
      expect(ticketRows(queueDir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf8'))).toMatchObject({
        pid: process.pid, goal: 'scoped-subjects', command: 'next',
      });
      expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      release();
      expect(existsSync(lockDir)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a heavy waiter that times out leaves no ticket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-timeout-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    writeFileSync(join(lockDir, 'marker'), 'held');
    let now = Date.now();
    const opened = now;
    let polls = 0;
    try {
      await expect(acquireHeavy(['wait'], {
        lockDir, pid: process.pid, goal: 'scoped-subjects', now: () => now, bindExit: false,
        sleep: async (ms: number) => {
          expect(ms).toBe(10_000);
          polls += 1;
          if (polls === 1) {
            expect(ticketRows(queueDir)).toHaveLength(1);
            now = opened + sixHours - 1;
            return;
          }
          if (polls === 2) {
            now = opened + sixHours + 1;
            return;
          }
          throw new Error(`polled ${polls} times`);
        },
      })).rejects.toThrow('The heavy QA lock stayed held for six hours');
      expect(polls).toBe(2);
      expect(readdirSync(queueDir).filter(name => name.endsWith('.json'))).toEqual([]);
      expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('held');
      expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      expect(existsSync(join(lockDir, 'info.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('status shows the heavy holder and the number of waiting tickets', () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-status-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    const dead = unusedPid();
    try {
      expect(heavyQaStatus(join(root, 'missing'))).toBe('free; 0 waiting');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'info.json'), JSON.stringify({
        pid: process.pid, goal: 'scoped-subjects', command: 'bun test affected', startedAt: '2026-10-04T00:00:00.000Z',
      }));
      mkdirSync(queueDir);
      writeFileSync(join(queueDir, 'a.json'), JSON.stringify({ pid: process.pid, command: 'a', arrivedAt: 2 }));
      writeFileSync(join(queueDir, 'b.json'), JSON.stringify({ pid: process.pid, command: 'b', arrivedAt: 3 }));
      writeFileSync(join(queueDir, 'dead.json'), JSON.stringify({ pid: dead, command: 'gone', arrivedAt: 1 }));
      expect(heavyQaStatus(lockDir)).toBe(
        `Goal scoped-subjects since 2026-10-04T00:00:00.000Z (pid ${process.pid}): bun test affected; 2 waiting`);
      expect(existsSync(join(queueDir, 'dead.json'))).toBe(false);
      writeFileSync(join(lockDir, 'info.json'), JSON.stringify({
        pid: dead, goal: 'scoped-subjects', command: 'bun test affected', startedAt: '2026-10-04T00:00:00.000Z',
      }));
      expect(heavyQaStatus(lockDir)).toBe('free; 2 waiting');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a heavy waiter removes its ticket on exit and on signal', async () => {
    const goalctl = join(import.meta.dir, 'goalctl.ts');
    const repo = join(import.meta.dir, '../..');
    for (const mode of ['exit', 'signal'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'heavy-exit-'));
      const lockDir = join(root, 'heavy');
      const queueDir = join(root, 'heavy-queue');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      writeFileSync(join(lockDir, 'marker'), 'held');
      const watch = mode === 'exit'
        ? `let stopping = false;
setInterval(() => {
  if (stopping) return;
  try {
    if (readdirSync(${JSON.stringify(queueDir)}).some(name => name.endsWith('.json'))) {
      stopping = true;
      writeFileSync(join(${JSON.stringify(queueDir)}, 'seen'), '1');
      setTimeout(() => process.exit(0), 30);
    }
  } catch { /* the queue directory is created with the ticket */ }
}, 15);`
        : '';
      writeFileSync(join(root, 'waiter.ts'), `import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireHeavy } from ${JSON.stringify(goalctl)};
${watch}
await acquireHeavy(['blocked'], { lockDir: ${JSON.stringify(lockDir)}, pollMs: 30_000, deadline: Date.now() + 60_000 });
`);
      const child = spawn('bun', [join(root, 'waiter.ts')], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = (chunk: unknown) => { output += String(chunk); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      let settled = false;
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => { settled = true; resolve(code); });
      });
      try {
        await waitForWaiter(child, () => mode === 'exit'
          ? existsSync(join(queueDir, 'seen'))
          : existsSync(queueDir) && readdirSync(queueDir).some(name => name.endsWith('.json')), () => output);
        if (mode === 'signal') child.kill('SIGTERM');
        expect(await exited).toBe(mode === 'signal' ? 143 : 0);
        expect(readdirSync(queueDir).filter(name => name.endsWith('.json'))).toEqual([]);
        expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('held');
        expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      } finally {
        if (!settled) child.kill('SIGKILL');
        await exited;
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

function waitForWaiter(child: ChildProcess, ready: () => boolean, output: () => string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ready()) return resolve();
      if (child.exitCode !== null) return reject(new Error(`waiter exited ${child.exitCode} before queuing\n${output()}`));
      if (Date.now() - started > 12_000) return reject(new Error(`waiter did not queue\n${output()}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
