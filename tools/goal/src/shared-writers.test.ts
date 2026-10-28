import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, markdown } from './test-support.ts';
import type { TaskState } from './types.ts';

function briefFile(h: ReturnType<typeof harness>, name: string, paths: string[], goal = 'fixture'): string {
  const path = join(h.settings.stateDirectory, `${name}.md`);
  writeFileSync(
    path,
    markdown
      .replace('goal: fixture', `goal: ${goal}`)
      .replace('paths: [result.txt]', `paths: ${JSON.stringify(paths)}`)
      .replace('command: [bun, test]', 'command: ["true"]'),
  );
  return path;
}

// Overlapping paths are not a reason to wait: a README writer held the Storybook and list-row tasks for hours
// (2026-10-28). Tasks run side by side and resolve any overlap at their rebase; only a declared `after` holds.
for (const state of ['running', 'landing'] as const satisfies readonly TaskState[]) {
  test(`dispatch does not hold a task because a ${state} task declares the same file`, () => {
    const h = harness();
    try {
      const sharedFile = 'services/kernel/src/library/entries.ts';
      const writer = h.tasks.dispatch(briefFile(h, 'writer', [sharedFile, 'packages/ui/README.md'], 'kernel'));
      h.store.updateTask({ taskId: writer.id, attempt: 0 }, (task) => {
        task.state = state;
      });
      const later = h.tasks.dispatch(briefFile(h, 'later', [sharedFile, 'packages/ui/README.md'], 'docs'));
      expect(later.state).toBe('ready');
      expect(later.brief.after).toEqual([]);
    } finally {
      h.dispose();
    }
  });
}
