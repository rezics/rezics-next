import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { completeAgentVerification, writeAgentVerificationPage } from '../../src/access/agent-verification.ts';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, unverifyAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import {
  readPublicSubjectPageCandidates,
  preparePublicSubjectPageCandidates,
  type PublicSubjectPageCandidate,
} from '../../src/semantic/subject-page-navigation.ts';
import type { SummaryReaderDependencies } from '../../src/semantic/summaries.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { epochFixture, type EpochFixture } from './support/identity-epoch.ts';

let db: GrowthDatabase;
let f: EpochFixture;
let app: ReturnType<typeof createKernel>;
let access: Access;
const routeKey = new Uint8Array(32).fill(47);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(48)]]) };
let ordinary: string;
const bookViews = [
  'overview',
  'editions',
  'characters',
  'credits',
  'relations',
  'reviews',
  'discussion',
  'lists',
  'details',
];
const personViews = [
  'overview',
  'characters',
  'works',
  'relations',
  'posts',
  'reviews',
  'discussion',
  'lists',
  'collections',
  'details',
];

beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await epochFixture(db.url);
  app = createKernel({
    pool: f.pool,
    routeKey,
    tokens,
    access: f.real.access,
    writeRate: f.real.writeRate,
    onAccessReady(native) {
      access = native;
    },
  });
  ordinary = await catalogue('Ordinary current book');
}, 120_000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});
function deps(): SummaryReaderDependencies {
  return { pool: f.pool, routeKey, access, actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 };
}
async function catalogue(label: string, type = 'schema:Book') {
  const key = randomUUID();
  const result = await createSubject(f.pool, {
    actor: await f.actor(),
    target: { route: 1, id: newId(1) },
    item: {
      type,
      labels: { en: label },
      statements: {
        'schema:url': [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/catalogue' } },
        ],
      },
    },
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: await f.authorization('subject:create'),
  });
  return result.subject.id;
}
async function feed() {
  const response = await app.handle(new Request('http://kernel.test/v1/subject-pages?limit=1000'));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    subjectPages: { id: string; target: unknown; views: string[] }[];
    next: string | null;
  };
}
const handleRoute = (handle: string) => createHash('sha256').update(handle).digest().readUInt16BE(0);
const uniqueHandle = () => `feed_${newId(0).replaceAll('-', '')}`;

// The existing native verification primitives install their real reciprocal identity mappings and receipts.
async function linked(handle: string | null) {
  const accountId = newId(0x5c30);
  const subjectId = await catalogue('Public catalogue person', 'schema:Person');
  const receiptId = newId(0);
  await f.pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,handle,display_name,transaction_id,
       pending_agent_subject_id,pending_agent_receipt_id)
     VALUES($1,$2,'actor','active',$3,'Public account',$2,$4,$5)`,
    [routeOf(accountId), accountId, handle, subjectId, receiptId],
  );
  if (handle)
    await f.pool.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     VALUES($1,$2,$3,'active',$3)`,
      [handleRoute(handle), handle, accountId],
    );
  await ensureAccountAgent(f.pool, { account: accountId, kind: 'person', name: 'Public account' });
  await verifyAccountAgent(f.pool, { account: accountId, catalogue: subjectId, receipt: receiptId });
  const input = {
    id: newId(0),
    accountId,
    accountKind: 'actor' as const,
    requestedBy: f.accounts.editor,
    catalogueSubjectId: subjectId,
    state: 'approving' as const,
    decisionReceiptId: receiptId,
    receiptId,
  };
  await writeAgentVerificationPage(f.pool, input);
  await completeAgentVerification(f.pool, input, () => new Date());
  return { accountId, subjectId, receiptId };
}

test('actual views and feed entries are withheld until native presentation is ready', async () => {
  expect((await readPublicSubjectPageCandidates(deps(), [ordinary])).get(ordinary)).toBeNull();
  expect((await feed()).subjectPages).toEqual([]);
  await setupPresentation(f.pool);
  const candidates = await readPublicSubjectPageCandidates(deps(), [ordinary]);
  expect(candidates.get(ordinary)).toEqual({
    id: ordinary,
    target: { family: 'subject', subjectId: ordinary },
    views: bookViews,
  });
  expect((await feed()).subjectPages.find((entry) => entry.id === ordinary)).toMatchObject(candidates.get(ordinary)!);
  const native = await app.handle(
    new Request('http://kernel.test/v1/pages:read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { subject: ordinary } }),
    }),
  );
  expect(native.status).toBe(200);
  expect(((await native.json()) as { views: string[] }).views).toEqual(bookViews);
}, 120_000);

test('Native publication feed includes only currently listable canonical Subject or Account destinations with genuine eligible views and no invented handleless navigation', async () => {
  const handle = uniqueHandle();
  const named = await linked(handle);
  const handleless = await linked(null);
  const independent = await catalogue('Independent ordinary person', 'schema:Person');
  const candidates = await readPublicSubjectPageCandidates(deps(), [
    named.subjectId,
    handleless.subjectId,
    independent,
  ]);
  expect(candidates.get(named.subjectId)).toEqual({
    id: named.subjectId,
    target: { family: 'account', accountId: named.accountId, canonicalPath: `/@${handle}` },
    views: ['overview', 'posts', 'reviews', 'collections'],
  });
  expect(candidates.get(handleless.subjectId)).toBeNull();
  expect(candidates.get(independent)?.target).toEqual({ family: 'subject', subjectId: independent });
  expect(candidates.get(independent)?.views).toEqual(personViews);
  const entries = (await feed()).subjectPages;
  expect(entries.find((entry) => entry.id === named.subjectId)).toMatchObject(candidates.get(named.subjectId)!);
  expect(entries.some((entry) => entry.id === handleless.subjectId)).toBe(false);
}, 120_000);

test('Native subject feed Account destinations contain only both template-offered and currently owner-admitted views after bounded final native Account revalidation', async () => {
  const handle = uniqueHandle();
  const target = await linked(handle);
  for (const { flags, views } of [
    { flags: { posts: false, reviews: true, collections: false }, views: ['overview', 'reviews'] },
    { flags: { posts: false, reviews: false, collections: false }, views: ['overview'] },
    {
      flags: { posts: true, reviews: true, collections: true },
      views: ['overview', 'posts', 'reviews', 'collections'],
    },
  ]) {
    await f.pool.query(
      'UPDATE access.account SET public_views=public_views || $3::jsonb WHERE route=$1 AND account_id=$2',
      [routeOf(target.accountId), target.accountId, JSON.stringify(flags)],
    );
    const expected: PublicSubjectPageCandidate = {
      id: target.subjectId,
      target: { family: 'account', accountId: target.accountId, canonicalPath: `/@${handle}` },
      views,
    };
    expect((await readPublicSubjectPageCandidates(deps(), [target.subjectId])).get(target.subjectId)).toEqual(expected);
    expect((await feed()).subjectPages.find((entry) => entry.id === target.subjectId)).toMatchObject(expected);
  }

  // Both revocation and newly admitted activity invalidate the captured destination for this attempt.
  for (const enabled of [false, true]) {
    const prepared = await preparePublicSubjectPageCandidates(deps(), [target.subjectId]);
    await f.pool.query(
      'UPDATE access.account SET public_views=public_views || $3::jsonb WHERE route=$1 AND account_id=$2',
      [routeOf(target.accountId), target.accountId, JSON.stringify({ posts: enabled })],
    );
    expect((await prepared.finish()).get(target.subjectId)).toBeNull();
    const views = enabled ? ['overview', 'posts', 'reviews', 'collections'] : ['overview', 'reviews', 'collections'];
    expect((await readPublicSubjectPageCandidates(deps(), [target.subjectId])).get(target.subjectId)?.views).toEqual(
      views,
    );
    expect((await feed()).subjectPages.find((entry) => entry.id === target.subjectId)?.views).toEqual(views);
  }
}, 120_000);

test('final native Account hydration cannot bypass the original Subject disclosure recheck', async () => {
  const target = await linked(uniqueHandle());
  const reader = deps();
  let armed = false;
  let changed = false;
  reader.access = {
    ...access,
    async authorize(client, actor, action, resource, evidence, time) {
      expect(actor.kind).toBe('anonymous');
      const allowed = await access.authorize(client, actor, action, resource, evidence, time);
      if (armed && !changed && action === 'subject:read' && resource.id === target.subjectId) {
        changed = true;
        await f.pool.query(
          "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=1 AND subject_id=$1",
          [target.subjectId],
        );
      }
      return allowed;
    },
  };
  const prepared = await preparePublicSubjectPageCandidates(reader, [target.subjectId]);
  armed = true;
  expect((await prepared.finish()).get(target.subjectId)).toBeNull();
  expect(changed).toBe(true);
  expect((await feed()).subjectPages.some((entry) => entry.id === target.subjectId)).toBe(false);
}, 120_000);

test('unknown, moved and hidden originals cannot borrow a visible terminal or retain a stale native projection', async () => {
  const terminal = await catalogue('Visible terminal');
  const original = await catalogue('Moved original');
  await f.merge(original, terminal);
  await f.pool.query(
    "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=1 AND subject_id=$1",
    [original],
  );
  const candidates = await readPublicSubjectPageCandidates(deps(), [original, terminal, newId(1)]);
  expect(candidates.get(original)).toBeNull();
  expect(candidates.get(terminal)?.target).toEqual({ family: 'subject', subjectId: terminal });
  expect(candidates.get([...candidates.keys()][2]!)).toBeNull();
  const prepared = await preparePublicSubjectPageCandidates(deps(), [terminal]);
  await f.pool.query(
    "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=1 AND subject_id=$1",
    [terminal],
  );
  expect((await prepared.finish()).get(terminal)).toBeNull();
  expect((await feed()).subjectPages.some((entry) => entry.id === original || entry.id === terminal)).toBe(false);
}, 120_000);

test('revocation and a current handle claim move during released native hydration withhold the old destination', async () => {
  for (const change of ['revoke', 'claim'] as const) {
    const handle = uniqueHandle();
    const target = await linked(handle);
    const reader = deps();
    reader.actor = await f.actor();
    let armed = false;
    let changed = false;
    reader.access = {
      ...access,
      async authorize(client, actor, action, resource, evidence, time) {
        expect(actor.kind).toBe('anonymous');
        const allowed = await access.authorize(client, actor, action, resource, evidence, time);
        if (armed && !changed && action === 'subject:read' && resource.id === target.subjectId) {
          changed = true;
          if (change === 'claim')
            await f.pool.query('UPDATE access.handle_claim SET account_id=$3 WHERE route=$1 AND normalized_handle=$2', [
              handleRoute(handle),
              handle,
              f.accounts.outsider,
            ]);
          else await unverifyAccountAgent(f.pool, { account: target.accountId, receipt: newId(0) });
        }
        return allowed;
      },
    };
    const prepared = await preparePublicSubjectPageCandidates(reader, [target.subjectId]);
    armed = true;
    expect((await prepared.finish()).get(target.subjectId)).toBeNull();
    expect(changed).toBe(true);
    const entries = (await feed()).subjectPages;
    expect(
      entries.some(
        (entry) =>
          entry.id === target.subjectId && (entry.target as { canonicalPath?: string }).canonicalPath === `/@${handle}`,
      ),
    ).toBe(false);
  }
}, 120_000);

test('public native metadata retains denied Access, source-home failures and the complete raw batch bound', async () => {
  const reader = deps();
  reader.access = {
    ...access,
    async authorize(client, actor, action, resource, evidence, time) {
      const allowed = await access.authorize(client, actor, action, resource, evidence, time);
      return resource.id === ordinary ? false : allowed;
    },
  };
  expect((await readPublicSubjectPageCandidates(reader, [ordinary])).get(ordinary)).toBeNull();
  const home = partitionOf(routeOf(ordinary)!);
  await f.pool.query("UPDATE core.partition SET write_state='moved',moved_to='elsewhere' WHERE partition_no=$1", [
    home,
  ]);
  try {
    await expect(readPublicSubjectPageCandidates(deps(), [ordinary])).rejects.toBeInstanceOf(CommandUnavailableError);
  } finally {
    await f.pool.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [home]);
  }
  let calls = 0;
  reader.pool = {
    connect() {
      calls++;
      throw new Error('Unexpected I/O');
    },
  } as unknown as typeof reader.pool;
  await expect(readPublicSubjectPageCandidates(reader, Array(101).fill(ordinary))).rejects.toBeInstanceOf(RangeError);
  await expect(readPublicSubjectPageCandidates(reader, [ordinary, 'bad'])).rejects.toBeInstanceOf(TypeError);
  await expect(readPublicSubjectPageCandidates({ ...reader, routeKey: new Uint8Array(0) }, [])).rejects.toBeInstanceOf(
    TypeError,
  );
  expect(await readPublicSubjectPageCandidates(reader, [])).toEqual(new Map());
  expect(calls).toBe(0);
}, 120_000);
