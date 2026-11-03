import { spawnSync } from 'node:child_process';
import { defaultPolicy } from './policy.ts';

export function publicationWorkflowCommand(executable: string, policy = defaultPolicy.publication): string[] {
  return [
    'timeout',
    '--signal=TERM',
    `--kill-after=${policy.workflowGraceSeconds}s`,
    `${policy.workflowDeadlineSeconds}s`,
    executable,
    'run',
    'storybook:deploy',
    '--force',
  ];
}

export function publicationInventoryFresh(
  observedAt: number,
  now: number,
  policy = defaultPolicy.publication,
): boolean {
  const age = now - observedAt;
  return Number.isFinite(age) && age >= -policy.observationClockSkewMs && age <= policy.inventoryMaxAgeMs;
}

/** Every helper in a publication uses this invocation's limits, including nested Git calls. */
export function publicationCommands(policy = defaultPolicy.publication) {
  function gitEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    return env;
  }

  type CommandResult = { code: number | null; stdout: string; stderr: string; error?: string };
  function runSync(command: string, args: string[], cwd: string): CommandResult {
    const result = spawnSync(command, args, {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      timeout: policy.commandTimeoutMs,
      maxBuffer: policy.commandBufferBytes,
    });
    return {
      code: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error.message } : {}),
    };
  }

  function git(root: string, args: string[]): CommandResult {
    return runSync('git', args, root);
  }

  function gitValue(root: string, args: string[], label: string): string {
    const result = git(root, args);
    if (result.code !== 0 || result.error)
      throw new Error(`${label}: ${result.error ?? (result.stderr.trim() || `git exited ${result.code}`)}`);
    return result.stdout.trim();
  }

  function requireCommit(root: string, value: string, label: string): string {
    if (!/^[0-9a-f]{40}$/i.test(value) || git(root, ['cat-file', '-e', `${value}^{commit}`]).code !== 0)
      throw new Error(`${label} is not an available full Git commit`);
    return value.toLowerCase();
  }

  function isAncestor(root: string, ancestor: string, commit: string): boolean {
    return git(root, ['merge-base', '--is-ancestor', ancestor, commit]).code === 0;
  }

  return { runSync, git, gitValue, requireCommit, isAncestor };
}
