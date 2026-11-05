import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from '../scripts/dev-stack.ts';
import { walkStackDirectory } from '../../../scripts/stack-run.ts';

// The retained-source copy owns generated state; the walk owns admission, ports and teardown.
test('fresh checkout starts native loopback Auth and signs a person into and out of Web without an external service', async () => {
  await mkdir(resolve(root, '.temp'), { recursive: true });
  const checkout = await mkdtemp(resolve(root, '.temp/dev-stack-'));
  let complete = false;
  let walk: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const archive = Bun.spawn(['git', 'archive', 'HEAD'], { cwd: root, stdout: 'pipe' });
    const extract = Bun.spawn(['tar', '-x', '-C', checkout], { stdin: archive.stdout });
    expect(await archive.exited).toBe(0);
    expect(await extract.exited).toBe(0);
    for (const workspace of ['', 'services/auth', 'services/kernel', 'apps/auth', 'apps/web'])
      await symlink(resolve(root, workspace, 'node_modules'), resolve(checkout, workspace, 'node_modules'));
    walk = Bun.spawn(
      [
        process.execPath,
        'services/auth/scripts/dev-stack.ts',
        'walk',
        '--',
        process.execPath,
        'services/auth/test/dev-stack-browser.ts',
      ],
      {
        cwd: checkout,
        env: {
          ...process.env,
          GOAL_TASK_ID: process.env.GOAL_TASK_ID ?? `dev-stack-${randomUUID()}`,
          GOAL_ACCEPTANCE_REQUIRES: 'browser,native',
          REZICS_WALK_STACK_DIR: walkStackDirectory(root, process.env),
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    expect(await walk.exited).toBe(0);
    complete = true;
  } finally {
    if (walk && walk.exitCode === null) {
      walk.kill('SIGTERM');
      await walk.exited;
    }
    if (complete) await rm(checkout, { recursive: true, force: true });
    else console.error(`Fresh-checkout stack evidence retained at ${checkout}/.temp`);
  }
}, 1_800_000);
