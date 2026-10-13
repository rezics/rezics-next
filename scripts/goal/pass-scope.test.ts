import { expect, test } from 'bun:test';
import { coordinatorPassCommand } from './pass-scope.ts';

const command = ['/opt/bun', '-e', 'await import("a $literal path");'];
const scoped = ['systemd-run', '--user', '--scope', '--collect', '--quiet', '--expand-environment=no', '--', ...command];

test('a supervisor in a user service launches the exact pass command in a separate scope', () => {
  expect(coordinatorPassCommand('0::/user.slice/user-1000.slice/user@1000.service/app.slice/goal-coordinator.service\n', command)).toEqual(scoped);
});

test('a supervisor in a session scope also launches in a separate scope', () => {
  expect(coordinatorPassCommand('0::/user.slice/user-1000.slice/session-3.scope\n', command)).toEqual(scoped);
});

test('the legacy systemd hierarchy identifies a service, independently of other controllers', () => {
  expect(coordinatorPassCommand('2:cpu:/user.slice\n1:name=systemd:/user.slice/coordinator.service\n', command)).toEqual(scoped);
});

test('no systemd unit keeps the direct launch, including a unit-like controller directory', () => {
  for (const cgroup of ['', '0::/\n', '0::/docker/container\n', '2:cpu:/example.service\n', 'not a cgroup']) {
    expect(coordinatorPassCommand(cgroup, command)).toEqual(command);
  }
  expect(command).toEqual(['/opt/bun', '-e', 'await import("a $literal path");']);
});
