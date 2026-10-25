import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorkspaceImports } from './workspace-imports.ts';

const repositoryRoot = join(import.meta.dir, '..');

function fixture(): { root: string; remove: () => void } {
  const temporaryRoot = join(repositoryRoot, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, 'workspace-imports-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true, devDependencies: { '@fixture/missing': '1' } }, null, 2),
  );
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

function writeJson(root: string, file: string, value: unknown): void {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(root: string, file: string, content: string): void {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeWorkspace(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): void {
  writeJson(root, `${directory}/package.json`, manifest);
  for (const [file, content] of Object.entries(files)) writeFile(root, `${directory}/${file}`, content);
}

test('a workspace that imports a package its package.json does not declare fails and the output names the workspace the file and the package', () => {
  const { root, remove } = fixture();
  try {
    writeWorkspace(
      root,
      'apps/web',
      { name: '@fixture/web' },
      {
        'src/static.ts': "import { value } from '@fixture/missing/static';\n",
        'src/type.ts': "import type { Value } from '@fixture/missing/type';\n",
        'src/reexport.ts': "export { value } from '@fixture/missing/reexport';\n",
        'src/side-effect.ts': "import '@fixture/missing/side-effect';\n",
        'src/dynamic.ts': "const module = import('@fixture/missing/dynamic');\n",
        'src/require.ts': "const module = require('@fixture/missing/require');\n",
      },
    );

    expect(checkWorkspaceImports(root)).toEqual(
      ['dynamic', 'reexport', 'require', 'side-effect', 'static', 'type'].map(
        (file) =>
          `error: @fixture/web apps/web/src/${file}.ts imports @fixture/missing, which its package.json does not declare`,
      ),
    );
  } finally {
    remove();
  }
});

test("declared packages builtins relative paths tsconfig path aliases and the workspace's own name pass", () => {
  const { root, remove } = fixture();
  try {
    writeFile(
      root,
      'tsconfig.base.json',
      '{\n  // Workspace aliases are inherited through extends.\n  "compilerOptions": {\n    "paths": { "@fixture/alias/*": ["src/*"], },\n  },\n}\n',
    );
    writeWorkspace(
      root,
      'packages/app',
      {
        name: '@fixture/app',
        dependencies: { '@fixture/production': '1' },
        devDependencies: { '@fixture/development': '1' },
        peerDependencies: { '@fixture/peer': '1' },
        optionalDependencies: { '@fixture/optional': '1' },
      },
      {
        'tsconfig.json': JSON.stringify({
          extends: '../../tsconfig.base.json',
          compilerOptions: { strict: true },
        }),
        'src/index.ts': [
          'const regex = /[\'"]/;',
          "import '@fixture/production';",
          "import '@fixture/production/subpath?raw';",
          "import '@fixture/development/subpath';",
          "import '@fixture/peer';",
          "import '@fixture/optional';",
          "import '@fixture/app';",
          "import '@fixture/app/subpath';",
          "import '@fixture/alias/util';",
          "import './relative';",
          "import '../relative';",
          "import '/absolute/path';",
          "import 'C:\\\\absolute\\\\path';",
          "import '\\\\\\\\server\\\\share';",
          "import 'fs';",
          "import 'node:fs';",
          "import 'bun';",
          "import 'bun:test';",
          "import 'cloudflare:workers';",
          "import 'virtual:generated';",
          "const sourceExample = \"import '@fixture/ignored'\"; // require('@fixture/ignored-too')",
          "const templateExample = `import '@fixture/ignored-template'`;",
        ].join('\n'),
      },
    );
    writeFile(root, 'packages/app/dist/ignored.ts', "import '@fixture/ignored-dist';\n");
    writeFile(root, 'packages/app/build/ignored.ts', "import '@fixture/ignored-build';\n");
    writeFile(root, 'packages/app/node_modules/ignored/index.ts', "import '@fixture/ignored-node-modules';\n");

    expect(checkWorkspaceImports(root)).toEqual([]);
  } finally {
    remove();
  }
});

test('generated declaration files are checked like source', () => {
  const { root, remove } = fixture();
  try {
    writeWorkspace(
      root,
      'packages/client',
      { name: '@fixture/client' },
      { 'src/generated/api.d.ts': "import type { Auth } from '@fixture/auth';\nexport type Client = Auth;\n" },
    );

    expect(checkWorkspaceImports(root)).toEqual([
      'error: @fixture/client packages/client/src/generated/api.d.ts imports @fixture/auth, which its package.json does not declare',
    ]);
  } finally {
    remove();
  }
});

test('root specs are checked against the root package.json', () => {
  const { root, remove } = fixture();
  try {
    writeJson(root, 'package.json', {
      name: 'fixture-root',
      devDependencies: { '@fixture/root-declared': '1' },
    });
    writeFile(
      root,
      'specs/example.test.ts',
      "import '@fixture/root-declared';\nimport '@fixture/root-missing/subpath';\n",
    );

    expect(checkWorkspaceImports(root)).toEqual([
      'error: fixture-root specs/example.test.ts imports @fixture/root-missing, which its package.json does not declare',
    ]);
  } finally {
    remove();
  }
});

test('the repository passes except for the imports listed in this brief', () => {
  const expected = [
    '@rezics/client packages/client/src/kernel/access/account-data.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/account-organization-role.sql.d.ts reylo',
    '@rezics/client packages/client/src/kernel/access/account-read.sql.d.ts reylo',
    '@rezics/client packages/client/src/kernel/access/auth-bindings.d.ts @rezics/auth',
    '@rezics/client packages/client/src/kernel/access/auth-bindings.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/auth-credential-capability-workflow-read.sql.d.ts reylo',
    '@rezics/client packages/client/src/kernel/access/auth-credential-capability.d.ts @rezics/auth',
    '@rezics/client packages/client/src/kernel/access/auth-credential-capability.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/authenticate.d.ts jose',
    '@rezics/client packages/client/src/kernel/access/durable-initiator.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/gates/catalogue.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/grant-command.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/lifecycle-20261025094010-command.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/lifecycle.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/operator.d.ts @rezics/auth',
    '@rezics/client packages/client/src/kernel/access/operator.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/workflow-approvals-read.sql.d.ts reylo',
    '@rezics/client packages/client/src/kernel/access/workflow-approvals.d.ts @rezics/auth',
    '@rezics/client packages/client/src/kernel/access/workflow-approvals.d.ts @rezics/auth',
    '@rezics/client packages/client/src/kernel/access/workflow-approvals.d.ts pg',
    '@rezics/client packages/client/src/kernel/access/write-rate.d.ts pg',
    '@rezics/client packages/client/src/kernel/command/command.d.ts pg',
    '@rezics/client packages/client/src/kernel/commerce/routes.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/document-read.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/content/document-read.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/erase-post.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/imported-contract.d.ts @rezics/definitions',
    '@rezics/client packages/client/src/kernel/content/imported-fields.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/media-import.d.ts @rezics/definitions',
    '@rezics/client packages/client/src/kernel/content/media-import.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/model.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/content/moderation.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/operation-contract.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/reads.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/reports.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/source-fence-command.d.ts pg',
    '@rezics/client packages/client/src/kernel/content/source-fence-routes.d.ts pg',
    '@rezics/client packages/client/src/kernel/events/log.d.ts pg',
    '@rezics/client packages/client/src/kernel/events/relays.d.ts pg',
    '@rezics/client packages/client/src/kernel/http/app.d.ts pg',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts @rezics/document',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts openapi-types',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts openapi-types',
    '@rezics/client packages/client/src/kernel/http/kernel.d.ts openapi-types',
    '@rezics/client packages/client/src/kernel/library/published-logs.d.ts pg',
    '@rezics/client packages/client/src/kernel/partition/partition.d.ts pg',
    '@rezics/client packages/client/src/kernel/request/access.d.ts pg',
    '@rezics/client packages/client/src/kernel/search/facets.d.ts @rezics/filter',
    '@rezics/client packages/client/src/kernel/search/http/routes.d.ts pg',
    '@rezics/client packages/client/src/kernel/search/service.d.ts @rezics/filter',
    '@rezics/client packages/client/src/kernel/search/service.d.ts pg',
    '@rezics/client packages/client/src/kernel/semantic/context.d.ts pg',
    '@rezics/client packages/client/src/kernel/semantic/http/definitions.d.ts pg',
    '@rezics/client packages/client/src/kernel/semantic/http/subjects.d.ts pg',
    '@rezics/client packages/client/src/kernel/semantic/item.d.ts @rezics/definitions',
    '@rezics/client packages/client/src/kernel/semantic/item.d.ts @rezics/definitions',
    '@rezics/client packages/client/src/kernel/semantic/item.d.ts @rezics/definitions',
    '@rezics/client packages/client/src/kernel/semantic/links.d.ts pg',
  ].map((entry) => {
    const [workspace, file, packageName] = entry.split(' ');
    return `error: ${workspace} ${file} imports ${packageName}, which its package.json does not declare`;
  });

  // Owners are removing these; a fix shrinks the list, and only an import outside it fails.
  const known = new Set(expected);
  expect(checkWorkspaceImports(repositoryRoot).filter((line) => !known.has(line))).toEqual([]);
});
