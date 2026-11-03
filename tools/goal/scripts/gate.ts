#!/usr/bin/env bun
import { join } from 'node:path';
import { defaultPolicy } from '../src/policy.ts';
import { BoundedProcessError, runBoundedInstallProcess, type ProcessLimits } from '../src/install-process.ts';

// Run from the candidate checkout, including its lockfile and dependencies, rather than the controller checkout.
export function runGoalGate(
  root = process.cwd(),
  limits: { install?: Partial<ProcessLimits>; check?: Partial<ProcessLimits> } = {},
  policy = defaultPolicy,
): number {
  const cwd = join(root, 'tools/goal');
  const steps = [
    {
      args: ['install', '--frozen-lockfile'],
      purpose: 'preparation' as const,
      limits: { ...policy.dependencies.install, ...limits.install },
    },
    { args: ['run', 'check'], purpose: 'check' as const, limits: { ...policy.dependencies.gate, ...limits.check } },
  ];
  for (const step of steps) {
    const command = ['bun', ...step.args];
    try {
      const output = runBoundedInstallProcess({
        command: command[0]!,
        args: command.slice(1),
        cwd,
        step: command.join(' '),
        purpose: step.purpose,
        limits: step.limits,
        policy,
      });
      if (output.stdout) process.stdout.write(output.stdout);
      if (output.stderr) process.stderr.write(output.stderr);
    } catch (error) {
      if (error instanceof BoundedProcessError) {
        if (error.stdout) process.stdout.write(error.stdout);
        if (error.stderr) process.stderr.write(error.stderr);
        process.stderr.write(`${error.summary}\n`);
        return error.exitCode;
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  const { loadSettings } = await import('../src/config.ts');
  process.exitCode = runGoalGate(process.cwd(), {}, loadSettings().policy);
}
