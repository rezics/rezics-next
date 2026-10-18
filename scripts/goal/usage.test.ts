import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('fresh capacity controls all new Claude launches, preserves other accounts and resumes the retained native session', () => {
  const parent = join(import.meta.dir, '../../.temp/claude-usage-tests'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-'));
  const module = (name: string) => JSON.stringify(join(import.meta.dir, name));
  try {
    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: directory }).status).toBe(0);
    const child = spawnSync(process.execPath, ['-e', `
      import { expect } from 'bun:test';
      import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { assertClaudeCapacity, briefDigest, capacityFiles, capacityFingerprint, writeCapacityFile } from ${module('claude-capacity.ts')};
      import { launch, launchGates, claudeSubscriptionEnvironment } from ${module('launch.ts')};
      import { currentUsage } from ${module('usage.ts')};
      const directory = process.cwd(), now = Date.now(), files = capacityFiles();
      const brief = join(directory, 'brief.md'); writeFileSync(brief, 'reviewed frontend brief');
      const research = { id: 'G-898', state: 'verified', attempts: [{ engine: 'codex-2', effort: 'max' }] };
      const worker = { id: 'G-899', brief, worktree: directory, state: 'stopped', engine: 'claude', paths: ['apps/web'],
        attempts: [{ n: 1, engine: 'claude', effort: 'high', session: 'kept-session', pid: 999999, output: join(directory, 'previous'), startedAt: new Date(now).toISOString() }] };
      const ledger = { tasks: { [research.id]: research, [worker.id]: worker } };
      const policy = { version: 1, repository: directory, enabled: true,
        review: { sha: 'independently-reviewed', by: 'codex-1/xhigh', fingerprint: capacityFingerprint() }, tasks: {
          [worker.id]: { brief, digest: briefDigest(brief), purpose: 'frontend-implementation', researchTask: research.id } } };
      const save = () => writeCapacityFile(join(directory, '.temp/goal-orchestration/ledger.json'), ledger);
      save();
      expect(() => assertClaudeCapacity('claude', worker, ledger)).toThrow('policy disabled');
      expect(() => assertClaudeCapacity('codex-2', worker, ledger)).not.toThrow();
      writeCapacityFile(files.policy, policy);
      // A weekly-only legacy status-line cache never establishes session capacity.
      writeCapacityFile(process.env.GOAL_USAGE_FILE, { at: now / 1000, rate_limits: { seven_day: { used_percentage: 1 } } });
      expect(currentUsage().level).toBe('unknown');
      expect(() => launchGates([], 'claude', true)).toThrow('capacity-unknown');
      const observation = { current: { observedAt: now, five_hour: { used: 20, resetsAt: now + 3600000 },
        seven_day: { used: 99, resetsAt: now + 86400000 } } };
      writeCapacityFile(files.observation, observation);
      expect(currentUsage()).toMatchObject({ level: 'normal', used: 20, weekUsed: 99 });
      expect(() => assertClaudeCapacity('claude', worker, ledger)).not.toThrow();
      expect(() => assertClaudeCapacity('claude', { ...worker, land: 'auto' }, ledger)).toThrow('automatic landing');
      expect(() => assertClaudeCapacity('claude', { ...worker, id: 'G-999' }, ledger)).toThrow('reviewed frontend');
      research.attempts[0].engine = 'codex-1';
      expect(() => assertClaudeCapacity('claude', worker, ledger)).toThrow('codex-2/max');
      research.attempts[0].engine = 'codex-2';
      writeFileSync(brief, 'changed brief'); expect(() => assertClaudeCapacity('claude', worker, ledger)).toThrow('brief changed');
      writeFileSync(brief, 'reviewed frontend brief');
      const outside = { ...worker, worktree: '/tmp' }; ledger.tasks[worker.id] = outside;
      expect(() => assertClaudeCapacity('claude', outside, ledger)).toThrow('another repository'); ledger.tasks[worker.id] = worker;
      observation.current.five_hour.used = 60; writeCapacityFile(files.observation, observation);
      expect(() => launchGates([], 'claude', true)).toThrow('about-reserve');
      policy.aboutCompletion = { verifiedAt: new Date(now).toISOString(), evidence: 'Explicit about completion verification' };
      writeCapacityFile(files.policy, policy); observation.current.five_hour.used = 99; writeCapacityFile(files.observation, observation);
      expect(() => assertClaudeCapacity('claude', worker, ledger)).not.toThrow();
      observation.current.seven_day.used = 100; writeCapacityFile(files.observation, observation);
      expect(() => assertClaudeCapacity('claude', worker, ledger)).toThrow('allowance-exhausted');
      observation.current.five_hour.used = 0; observation.current.seven_day.used = 80;
      observation.current.five_hour.resetsAt = now + 5 * 3600000; writeCapacityFile(files.observation, observation);
      worker.claudeCapacity = { attempt: 1, owner: { pid: 999999, start: '1', boot: 'fixture', cgroup: '' }, pause: {
        at: now - 3600000, signalledAt: now - 3600000, stage: 'waiting', reason: 'about-reserve',
        five_hour: { used: 60, resetsAt: now - 1 }, seven_day: observation.current.seven_day } };
      save(); expect(() => assertClaudeCapacity('claude', worker, ledger)).not.toThrow();
      const bin = join(directory, 'bin'); mkdirSync(bin);
      const launched = join(directory, 'launched.json');
      writeFileSync(join(bin, 'claude'), '#!' + process.execPath + '\\n'
        + 'import { writeFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path"; '
        + 'if (process.argv.includes("auth")) { console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FIXTURE_AUTH_METHOD || "claude.ai",apiProvider:"firstParty",configDirectory:process.env.CLAUDE_CONFIG_DIR || join(homedir(),".claude")})); process.exit(0); } writeFileSync(' + JSON.stringify(launched)
        + ', JSON.stringify({ args: process.argv.slice(2), env: { api: process.env.ANTHROPIC_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, marker: process.env.GOAL_TASK_ID } })); await Bun.sleep(200); console.log(JSON.stringify({result:"RESULT: partial",session_id:"kept-session"}));');
      chmodSync(join(bin, 'claude'), 0o755);
      process.env.PATH = bin + ':' + process.env.PATH;
      process.env.ANTHROPIC_API_KEY = 'fixture-paid-key'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-other-account';
      for (const auth of ['api_key', 'api_key_helper', 'third_party', 'oauth_token', 'none']) {
        process.env.FIXTURE_AUTH_METHOD = auth;
        expect(() => launch(worker, 'high', 'kept-session', 'resume retained work', true, 'manager', 'claude', 'step')).toThrow('native subscription authentication required');
      }
      delete process.env.FIXTURE_AUTH_METHOD;
      const resumed = launch(worker, 'high', 'kept-session', 'resume retained work', true, 'manager', 'claude', 'step');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { try { readFileSync(launched); break; } catch { await Bun.sleep(10); } }
      const recorded = JSON.parse(readFileSync(launched, 'utf8'));
      expect(recorded.args).toContain('--resume'); expect(recorded.args).toContain('kept-session');
      expect(recorded.args).toContain('--dangerously-skip-permissions'); expect(recorded.args).toContain('Agent');
      expect(recorded.env).toEqual({ marker: worker.id });
      expect(worker.claudeCapacity.attempt).toBe(2); expect(worker.claudeCapacity.pause).toBeUndefined();
      expect(claudeSubscriptionEnvironment({ ANTHROPIC_API_KEY: 'paid', CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '7', CLAUDE_BG_AUTH_SNAPSHOT_PATH: '/snapshot', CCR_OAUTH_TOKEN_FILE: '/token',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', AGENT_PROXY_AUTH_TOKEN: 'fixture-proxy', PATH: '/fixture', CODEX_HOME: '/codex' }))
        .toEqual({ PATH: '/fixture', CODEX_HOME: '/codex' });
      await Bun.sleep(250);
    `], { cwd: directory, encoding: 'utf8', timeout: 20000, env: { ...process.env,
      GOAL_SETTINGS_DIRECTORY: join(directory, '.goalctl'), GOAL_USAGE_FILE: join(directory, 'legacy-usage.json'),
      GOAL_MEMORY_FLOOR_GIB: '0' } });
    expect(child.status, child.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
