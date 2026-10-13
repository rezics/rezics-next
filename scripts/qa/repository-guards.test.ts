import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { outcomeRepositoryViolations, outcomeTestViolations } from './repository-guards.ts';

const file = 'tests/qa/integration/outcomes/reading.test.ts';

test('outcome guard refuses product imports and module mocks in outcome files', () => {
  for (const source of [
    "import { app } from '../../../../services/main/src/app.ts';",
    "import type { User } from '../../../../services/account/src/auth.ts';",
    "export { read } from '../../../../apps/web/src/read.ts';",
    "await import('../../../../services/main/src/app.ts');",
    "const app = require('../../../../services/main/src/app.ts');",
    "import app = require('../../../../services/main/src/app.ts');",
    "import app from 'services/main/src/app.ts';",
    "import app from '/workspace/services/main/src/app.ts';",
    "import app from 'file:///workspace/apps/web/src/app.ts';",
    "mock . module('owner', () => ({}));",
    "mock['module']('owner', () => ({}));",
    "import { type User } from '../../../../services/account/src/auth.ts';",
  ])
    expect(outcomeTestViolations(file, source), source).toHaveLength(1);
});

test('outcome guard accepts public clients, persona fixtures, comments and other integration tests', () => {
  expect(
    outcomeTestViolations(
      file,
      `
    import { expect, test } from 'bun:test';
    import { personaSessions } from '../../support/personas.ts';
    import type { Response } from '../../../../packages/api-client/index.ts';
    // mock.module('owner', () => ({}));
    const example = "services/main/src/app.ts";
  `,
    ),
  ).toEqual([]);
  expect(
    outcomeTestViolations(
      'tests/qa/integration/owner.test.ts',
      "import app from '../../../services/main/src/app.ts'; mock.module('app', () => ({}));",
    ),
  ).toEqual([]);
});

test('outcome inventory reads every nested outcome file', () => {
  mkdirSync('.temp', { recursive: true });
  const root = mkdtempSync(resolve('.temp/outcome-guard-'));
  try {
    const directory = join(root, 'tests/qa/integration/outcomes/nested');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'refused.test.ts'),
      "import app from '../../../../../services/main/src/app.ts';",
    );
    writeFileSync(
      join(directory, 'accepted.test.ts'),
      "import { personaSessions } from '../../../support/personas.ts';",
    );
    expect(outcomeRepositoryViolations(root)).toEqual([
      'tests/qa/integration/outcomes/nested/refused.test.ts: imports product source: ../../../../../services/main/src/app.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all repository outcome tests stay at the public API boundary', () => {
  expect(outcomeRepositoryViolations()).toEqual([]);
});
