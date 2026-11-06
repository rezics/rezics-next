import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, expectTypeOf, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import {
  clientDeclarationCacheDirectory,
  clientDeclarations,
  committedDeclarations,
  rewriteSqlDeclarationSpecifiers,
  runtimeClosure,
} from './client.ts';

const repository = resolve(import.meta.dir, '../../..');

test('generated Library operation requests accept removal and require status state', () => {
  mkdirSync(resolve(repository, '.temp'), { recursive: true });
  const fixture = mkdtempSync(resolve(repository, '.temp/kernel-library-client-test-'));
  try {
    writeFileSync(
      resolve(fixture, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve(repository, 'packages/client/tsconfig.json'),
        include: ['./request.ts'],
      }),
    );
    writeFileSync(
      resolve(fixture, 'request.ts'),
      `import type { KernelClient } from ${JSON.stringify(resolve(repository, 'packages/client/src/index.ts'))};
declare const client: KernelClient;
type Request = Parameters<KernelClient['libraryOperations']['post']>[0];
const removal = {
  action: 'remove_from_library',
  selection: { kind: 'explicit', targets: [{ subjectId: 'subject-id' }] },
} satisfies Request;
const status = {
  action: 'set_status', state: 'reading', selection: removal.selection,
} satisfies Request;
// @ts-expect-error A status change still requires its destination state.
const missingState: Request = { action: 'set_status', selection: removal.selection };
const headers = { 'idempotency-key': 'request-key' };
const preview = await client.libraryOperations.post(removal, { headers });
await client.libraryOperations.post(status, { headers });
const operation = client.libraryOperations({ operationId: 'operation-id' });
const confirmed = await operation.$confirm.post({}, { headers });
const current = await operation.get();
const outcomes = await operation.outcomes.get({ query: { limit: 10, state: 'applied' } });
const cancelled = await operation.$cancel.post({}, { headers });
for (const result of [preview, confirmed, current, cancelled]) {
  if (result.data && 'operation' in result.data) {
    const id: string = result.data.operation.id;
    const action: string = result.data.operation.action;
  }
}
if (outcomes.data) {
  const next: string | null = outcomes.data.next;
  for (const outcome of outcomes.data.outcomes) {
    const subjectId: string = outcome.subjectId;
    const absentDeletion: typeof outcome.deletion = null;
    const absentMemberDeletion: typeof outcome.memberDeletion = null;
    void [absentDeletion, absentMemberDeletion];
    if (outcome.deletion) {
      const deletion: { deletionId: string; revision: number; restoreUntil: string } = outcome.deletion;
      void deletion;
    }
    if (outcome.memberDeletion) {
      const memberDeletion: { deletionId: string; revision: number; purgeAfter: string } = outcome.memberDeletion;
      void memberDeletion;
    }
  }
}
`,
    );
    const result = spawnSync(
      resolve(repository, 'node_modules/.bin/tsc'),
      ['--noEmit', '-p', resolve(fixture, 'tsconfig.json')],
      { cwd: repository, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}${result.stderr}`).toBe('');
    expect(result.status).toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 60_000);

const reconcileOrder = (client: KernelClient) =>
  client.orders({ orderId: 'order-id' }).$reconcile.post(
    {},
    {
      headers: { authorization: 'Bearer session', 'idempotency-key': 'reconciliation-key' },
    },
  );

test('generated KernelClient exposes typed order reconciliation', () => {
  type ReconciliationResponse = Awaited<ReturnType<typeof reconcileOrder>>;
  expectTypeOf<NonNullable<ReconciliationResponse['data']>>().toMatchTypeOf<{
    orderId: string;
    reconciliation: 'queued';
  }>();
});

test('incremental client declarations match a clean emit after one source file changes', () => {
  mkdirSync(resolve(repository, '.temp'), { recursive: true });
  const fixture = mkdtempSync(resolve(repository, '.temp', 'kernel-client-test-'));
  const kernel = resolve(fixture, 'services/kernel');
  const incrementalCache = resolve(fixture, '.temp/incremental');
  const cleanCache = resolve(fixture, '.temp/clean');
  try {
    mkdirSync(resolve(kernel, 'src/http'), { recursive: true });
    mkdirSync(resolve(kernel, 'src/search'), { recursive: true });
    mkdirSync(resolve(fixture, 'packages/search-text/src'), { recursive: true });
    writeFileSync(
      resolve(kernel, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          strict: true,
          paths: { '@rezics/search-text': ['../../packages/search-text/src/index.ts'] },
        },
        include: ['src'],
      }),
    );
    writeFileSync(resolve(kernel, 'src/http/kernel.ts'), "export type { Response } from './response';\n");
    writeFileSync(resolve(kernel, 'src/http/request.ts'), 'export interface Request { id: string }\n');
    writeFileSync(
      resolve(kernel, 'src/search/text.ts'),
      "import type { TextNode } from '@rezics/search-text';\nexport type SearchNode = TextNode;\n",
    );
    writeFileSync(
      resolve(fixture, 'packages/search-text/src/index.ts'),
      "export type TextNode = { kind: 'term'; value: string };\n",
    );
    mkdirSync(resolve(fixture, 'packages/client/src'), { recursive: true });
    writeFileSync(
      resolve(fixture, 'packages/client/src/index.ts'),
      "export type { PublicOnly } from './kernel/http/public-only.d.ts';\nexport type { SearchNode } from './kernel/search/text';\n",
    );
    writeFileSync(resolve(kernel, 'src/http/public-only.ts'), 'export interface PublicOnly { revision: number }\n');
    const response = resolve(kernel, 'src/http/response.ts');
    writeFileSync(response, 'export interface Response { message: string }\n');
    const checkoutCache = clientDeclarationCacheDirectory(fixture, kernel);

    clientDeclarations(kernel, { repositoryRoot: fixture, cacheDirectory: incrementalCache });
    writeFileSync(response, 'export interface Response { text: string }\n');
    expect(clientDeclarationCacheDirectory(fixture, kernel)).toBe(checkoutCache);
    const incremental = clientDeclarations(kernel, { repositoryRoot: fixture, cacheDirectory: incrementalCache });
    const clean = clientDeclarations(kernel, { repositoryRoot: fixture, cacheDirectory: cleanCache });

    expect([...incremental.entries()]).toEqual([...clean.entries()]);
    expect(incremental.get('http/public-only.d.ts')).toContain('revision: number;');
    expect(incremental.get('search/text.d.ts')).toContain("'@rezics/search-text'");
    expect(readFileSync(resolve(incrementalCache, 'tsconfig.tsbuildinfo'), 'utf8').length).toBeGreaterThan(0);
    const config = JSON.parse(readFileSync(resolve(incrementalCache, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: {
        rootDir: string;
        outDir: string;
        noEmit: boolean;
        declaration: boolean;
        emitDeclarationOnly: boolean;
        incremental: boolean;
        tsBuildInfoFile: string;
      };
    };
    expect(config.compilerOptions).toEqual({
      rootDir: fixture,
      outDir: resolve(incrementalCache, 'emit'),
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      incremental: true,
      tsBuildInfoFile: resolve(incrementalCache, 'tsconfig.tsbuildinfo'),
    });
    writeFileSync(resolve(kernel, 'src/http/extra.ts'), 'export type Extra = string;\n');
    expect(clientDeclarationCacheDirectory(fixture, kernel)).not.toBe(checkoutCache);
    const withKernelAddition = clientDeclarationCacheDirectory(fixture, kernel);
    writeFileSync(resolve(fixture, 'packages/search-text/src/extra.ts'), 'export type Extra = string;\n');
    expect(clientDeclarationCacheDirectory(fixture, kernel)).not.toBe(withKernelAddition);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('KernelClient accepts order reconciliation headers and types the queued response', () => {
  const reconcile = (client: KernelClient) =>
    client
      .orders({ orderId: 'order-id' })
      .$reconcile.post({}, { headers: { authorization: 'Bearer token', 'idempotency-key': 'request-key' } });
  type QueuedResponse = Extract<
    NonNullable<Awaited<ReturnType<typeof reconcile>>['data']>,
    { reconciliation: 'queued' }
  >;
  const response: QueuedResponse = { orderId: 'order-id', reconciliation: 'queued' };
  expect(response.reconciliation).toBe('queued');
});

test('installed declarations point SQL imports at .sql.d.ts so a consumer mapper cannot load Kernel SQL', () => {
  expect(rewriteSqlDeclarationSpecifiers("import read from './account-read.sql';\n")).toBe(
    "import read from './account-read.sql.d.ts';\n",
  );
  expect(rewriteSqlDeclarationSpecifiers("import read from './account-read.sql.d.ts';\n")).toBe(
    "import read from './account-read.sql.d.ts';\n",
  );
  expect(
    [...committedDeclarations()]
      .filter(([, content]) => /from ['"][^'"]+\.sql['"]/.test(content))
      .map(([file]) => file),
  ).toEqual([]);
});

test('the installed package ships the question-management schemas as byte copies of their Kernel source', () => {
  const sourceRoot = resolve(repository, 'services/kernel/src');
  const packageRoot = resolve(repository, 'packages/client/src/kernel');
  const closure = runtimeClosure();
  expect([...closure.keys()]).toEqual([
    'memoized.ts',
    'rating/question-management-schemas.ts',
    'rating/vote-response-schemas.ts',
  ]);
  for (const [key, content] of closure) {
    expect(content).toBe(readFileSync(resolve(sourceRoot, key), 'utf8'));
    expect(readFileSync(resolve(packageRoot, key), 'utf8')).toBe(content);
  }
});

test('generated KernelClient exposes Realm question management, caption history and command results', () => {
  const management = (client: KernelClient) =>
    client.realms({ realmId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702001' })['rating-questions'].management.get({
      query: {},
    });
  const history = (client: KernelClient) =>
    client['rating-questions']({ questionId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702102' }).labels.get({
      query: { limit: 20 },
    });
  const create = (client: KernelClient) =>
    client.realms({ realmId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702001' })['rating-questions'].post(
      {
        meaning: 'Judge translation independently.',
        label: 'Translation',
        grain: 'release',
        scale: { min: 0, max: 20, displayStep: 2 },
      },
      { headers: { 'idempotency-key': 'create-key' } },
    );
  const caption = (client: KernelClient) =>
    client['rating-questions']({ questionId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702102' }).label.put(
      { expectedLabelRevision: 1, label: 'Translation clarity' },
      { headers: { 'idempotency-key': 'caption-key' } },
    );
  const retire = (client: KernelClient) =>
    client['rating-questions']({ questionId: '019a1b2c-3d4e-7f00-8a00-5ab1ec702102' })['$retire'].post(
      { expectedLifecycleRevision: 1 },
      { headers: { 'idempotency-key': 'retire-key' } },
    );
  type ManagementResponse = NonNullable<Awaited<ReturnType<typeof management>>['data']>;
  type HistoryResponse = NonNullable<Awaited<ReturnType<typeof history>>['data']>;
  type CreateResponse = NonNullable<Awaited<ReturnType<typeof create>>['data']>;
  type CaptionResponse = NonNullable<Awaited<ReturnType<typeof caption>>['data']>;
  type RetireResponse = NonNullable<Awaited<ReturnType<typeof retire>>['data']>;
  expectTypeOf<ManagementResponse>().toEqualTypeOf<import('@rezics/client').QuestionManagementPage>();
  expectTypeOf<HistoryResponse>().toEqualTypeOf<import('@rezics/client').QuestionLabelHistory>();
  type CreateAck = Extract<CreateResponse, { id: string; label: string; revision: number }>;
  expectTypeOf<CreateAck>().not.toEqualTypeOf<never>();
  expectTypeOf<CaptionResponse>().toEqualTypeOf<import('@rezics/client').QuestionLabelResult>();
  expectTypeOf<RetireResponse>().toEqualTypeOf<import('@rezics/client').QuestionLifecycleResult>();
});

test('the runtime closure refuses an import the installed package cannot provide', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'runtime-closure-'));
  try {
    writeFileSync(resolve(directory, 'entry.ts'), "import { z } from 'zod';\nexport const schema = z;\n");
    expect(() => runtimeClosure(['entry.ts'], directory)).toThrow('imports zod');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
