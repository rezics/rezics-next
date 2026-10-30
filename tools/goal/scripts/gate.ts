#!/usr/bin/env bun
import { join } from 'node:path';
import {
  BoundedProcessError,
  GOAL_GATE_CHECK_LIMITS,
  INSTALL_PROCESS_LIMITS,
  runBoundedInstallProcess,
  type ProcessLimits,
} from '../src/install-process.ts';

// Run from the candidate checkout, including its lockfile and dependencies, rather than the controller checkout.
export function runGoalGate(
  root = process.cwd(),
  limits: { install?: Partial<ProcessLimits>; check?: Partial<ProcessLimits> } = {},
): number {
  const cwd = join(root, 'tools/goal');
  const steps = [
    { args: ['install', '--frozen-lockfile'], limits: { ...INSTALL_PROCESS_LIMITS, ...limits.install } },
    { args: ['run', 'check'], limits: { ...GOAL_GATE_CHECK_LIMITS, ...limits.check } },
  ];
  for (const step of steps) {
    const command = ['bun', ...step.args];
    try {
      const output = runBoundedInstallProcess({
        command: command[0]!,
        args: command.slice(1),
        cwd,
        step: command.join(' '),
        limits: step.limits,
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

if (import.meta.main) process.exitCode = runGoalGate();
