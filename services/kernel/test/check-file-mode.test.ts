import { expect, test } from 'bun:test';
import { diagnosticFiles, ownDiagnostics } from '../scripts/check.ts';

test('file mode reports diagnostics in changed kernel files as well as named tests', () => {
  const files = diagnosticFiles(['test/check-file-mode.test.ts'], '/repo/services/kernel', 'task-base', () => [
    'services/kernel/test/check-file-mode.test.ts',
    'services/kernel/src/access/erasure.ts',
    'services/kernel/src/access/erasure.sql',
    'services/auth/src/session.ts',
    'README.md',
  ]);

  const diagnostics = ownDiagnostics(
    [
      'src/access/erasure.ts(215,5): error TS2322: Type string is not assignable to number.',
      'test/check-file-mode.test.ts(1,1): error TS2304: Cannot find name missing.',
      'src/unchanged.ts(1,1): error TS2304: Cannot find name unrelated.',
      'src/access/erasure.sql(1,1): error reylo1: column "missing" does not exist',
      'src/foreign.sql(1,1): error reylo14: relation "other" does not exist',
    ].join('\n'),
    files,
  );

  expect(files).toEqual(['src/access/erasure.sql', 'src/access/erasure.ts', 'test/check-file-mode.test.ts']);
  expect(diagnostics).toHaveLength(3);
  expect(diagnostics.join('\n')).toContain('src/access/erasure.ts(215,5)');
  expect(diagnostics.join('\n')).toContain('test/check-file-mode.test.ts(1,1)');
  expect(diagnostics.join('\n')).toContain('src/access/erasure.sql(1,1)');
  expect(diagnostics.join('\n')).not.toContain('src/unchanged.ts');
  expect(diagnostics.join('\n')).not.toContain('src/foreign.sql');
});
