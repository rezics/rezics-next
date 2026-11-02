import { expect, test } from 'bun:test';
import { resolveImportConflicts } from './import-conflicts.ts';

const conflict = (ours: string, theirs: string, body: string) =>
  `import { expect, test } from 'bun:test';\n<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> stabilize\n\n${body}`;

test('two sides adding imports keep both when the file uses both', () => {
  const text = conflict(
    "import { trustedAccessPorts } from '../support/trusted-access.ts';\n",
    "import { dropTestDatabase } from '../support/drop-test-database.ts';\n",
    'trustedAccessPorts(); await dropTestDatabase(admin, name);\n',
  );
  expect(resolveImportConflicts(text)).toBe(
    "import { expect, test } from 'bun:test';\nimport { trustedAccessPorts } from '../support/trusted-access.ts';\n" +
      "import { dropTestDatabase } from '../support/drop-test-database.ts';\n\ntrustedAccessPorts(); await dropTestDatabase(admin, name);\n",
  );
});

test('named imports from one module are merged, and names the file no longer uses are dropped', () => {
  const text = conflict(
    "import { observeSql } from './support/sql-observer.ts';\nimport { gone } from './gone.ts';\n",
    "import { observeSql, permissionResourceId } from './support/sql-observer.ts';\n",
    'observeSql(); permissionResourceId();\n',
  );
  expect(resolveImportConflicts(text)).toBe(
    "import { expect, test } from 'bun:test';\nimport { observeSql, permissionResourceId } from './support/sql-observer.ts';\n\n" +
      'observeSql(); permissionResourceId();\n',
  );
});

test('a hunk with anything but single-line imports, or one name from two modules, is left to a person', () => {
  expect(resolveImportConflicts(conflict('const a = 1;\n', 'const a = 2;\n', 'a;\n'))).toBeUndefined();
  expect(
    resolveImportConflicts(conflict("import {\n  a,\n} from './a.ts';\n", "import { b } from './b.ts';\n", 'a; b;\n')),
  ).toBeUndefined();
  expect(
    resolveImportConflicts(
      conflict("import { clock } from './a.ts';\n", "import { clock } from './b.ts';\n", 'clock;\n'),
    ),
  ).toBeUndefined();
  expect(resolveImportConflicts('no conflict\n')).toBeUndefined();
});

test('a used local name from two exports of one module is left to a person', () => {
  expect(
    resolveImportConflicts(
      conflict(
        "import { load as setup } from './harness.ts';\n",
        "import { create as setup } from './harness.ts';\n",
        'setup();\n',
      ),
    ),
  ).toBeUndefined();
});

test('side-effect imports stay, and a type-only specifier of the same export yields to the value form', () => {
  const text = conflict(
    "import './polyfill.ts';\nimport { type gone } from './gone.ts';\n",
    "import './polyfill.ts';\nimport { gone } from './gone.ts';\n",
    'gone();\n',
  );
  expect(resolveImportConflicts(text)).toBe(
    "import { expect, test } from 'bun:test';\nimport './polyfill.ts';\nimport { gone } from './gone.ts';\n\ngone();\n",
  );
});

test('namespace plus named stay valid, and effect order is kept or left unresolved', () => {
  expect(
    resolveImportConflicts(
      conflict(
        "import * as harness from './harness.ts';\n",
        "import { load } from './harness.ts';\n",
        'harness; load();\n',
      ),
    ),
  ).toBe(
    "import { expect, test } from 'bun:test';\nimport * as harness from './harness.ts';\n" +
      "import { load } from './harness.ts';\n\nharness; load();\n",
  );
  expect(
    resolveImportConflicts(
      conflict(
        "import { clock } from './clock.ts';\nimport './polyfill.ts';\n",
        "import { clock } from './clock.ts';\n",
        'clock;\n',
      ),
    ),
  ).toBe(
    "import { expect, test } from 'bun:test';\nimport { clock } from './clock.ts';\nimport './polyfill.ts';\n\nclock;\n",
  );
  expect(
    resolveImportConflicts(
      conflict(
        "import { a } from './a.ts';\nimport './polyfill.ts';\n",
        "import { b } from './b.ts';\nimport './polyfill.ts';\n",
        'a; b;\n',
      ),
    ),
  ).toBe(
    "import { expect, test } from 'bun:test';\nimport { a } from './a.ts';\nimport { b } from './b.ts';\n" +
      "import './polyfill.ts';\n\na; b;\n",
  );
  expect(
    resolveImportConflicts(
      conflict("import './a.ts';\nimport './b.ts';\n", "import './b.ts';\nimport './a.ts';\n", 'export {};\n'),
    ),
  ).toBeUndefined();
});
