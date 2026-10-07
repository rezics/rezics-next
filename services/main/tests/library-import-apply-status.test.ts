import { expect, test } from 'bun:test';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { LibraryFileMissing } from '../src/modules/library-import/file-store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { libraryImportsRoutes } from '../src/routes/library-imports.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const upload = '00000000-0000-4000-8000-000000000002';
const progress = { total: 3, completed: 1, issues: 0, pending: true, state: 'pending', reason: null };

function fixture(options: { owner?: boolean; verify?: () => Promise<unknown>; missing?: boolean } = {}) {
  const touched: string[] = [];
  const record = (name: string) => async () => { touched.push(name); throw new Error(`Unexpected ${name}`); };
  const deps = {
    account: { verify: options.verify ?? (async () => ({ issuer: 'https://account.test', subject: 'reader' })) },
    access: { canReadAsBaselineMember: async () => options.owner ?? true },
    libraryFiles: {
      progress: async () => {
        touched.push('progress');
        if (options.missing) throw new LibraryFileMissing('Library import file is missing');
        return progress;
      },
      sealOn: record('sealOn'),
      jobs: { status: record('jobs.status'), accept: record('jobs.accept') },
    },
    libraryImport: {},
  } as unknown as MainWorkDependencies;
  const app = libraryImportsRoutes(deps);
  const read = (headers: Record<string, string> = { 'idempotency-key': 'poll-1' }) => app.handle(new Request(
    `http://main.local/v1/me/library-imports/${upload}/apply?actingSubject=${encodeURIComponent(agent)}`,
    { headers: { authorization: 'Bearer reader', ...headers } }));
  return { read, touched };
}

test('reading apply status with an Idempotency-Key never seals, accepts or schedules a job', async () => {
  const { read, touched } = fixture();
  for (let poll = 0; poll < 3; poll++) {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(progress);
  }
  expect(touched).toEqual(['progress', 'progress', 'progress']);
});

test('apply status keeps its refusals: unauthorized, another owner, deleted or expired upload', async () => {
  const unauthorized = fixture({ verify: async () => { throw new AccountAssertionDenied('denied'); } });
  expect((await unauthorized.read()).status).toBe(401);
  expect(unauthorized.touched).toEqual([]);
  const other = fixture({ owner: false });
  expect((await other.read()).status).toBe(403);
  expect(other.touched).toEqual([]);
  const gone = fixture({ missing: true });
  expect((await gone.read()).status).toBe(404);
  expect(gone.touched).toEqual(['progress']);
});
