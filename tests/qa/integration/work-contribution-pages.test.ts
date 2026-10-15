import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { activateTextContribution, textContributionDigest } from '../../../services/main/src/modules/contribution/draft.ts';
import { TemplateSeekIndex } from '../../../services/main/src/modules/query/seek-index.ts';
import { RealmSubmissionReads } from '../../../services/main/src/modules/realm-submission/reads.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { foregroundCounted } from './support/operation-cost.ts';
import { comparableBody } from '../support/hidden-id-equality.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type Card = { contribution: string; draftHead: string; author: string };
type Page<T> = { items: T[]; nextCursor: string | null };
type Statement = { text: string; values: unknown[] };
type Plan = { 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number;
  'Node Type': string; 'Index Cond'?: string; Plans?: Plan[] };
const short = (value: string) => value.slice(-36);

test('Work pages: author and reviewer see exact private drafts; strangers cannot; 10 to 1,000 unrelated entries keep page work flat', async () => {
  const stack = await startMediaStack('work-contribution-pages');
  try {
    const author = await stack.member('author'), reviewer = await stack.member('reviewer');
    const stranger = await stack.member('stranger');
    const members = [author, reviewer, stranger];
    const work = await stack.privateWork(author.actor);
    const unrelated = await stack.privateWork(author.actor);
    for (const member of [author, reviewer]) await member.grant(`work:read:${work.work}`, 'work.read');
    const contributions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const input = { work: work.work, actingSubject: author.actor, language: 'en', body: `Private draft ${i}` };
      const created = await activateTextContribution(stack.env, stack.admission(author.actor,
        `contribution:create:${work.work}`, 'contribution.create', textContributionDigest(input)), input);
      expect(created.outcome).toBe('succeeded');
      contributions.push(created.contribution!);
      for (const member of [author, reviewer]) await member.grant(`contribution:read:${created.contribution}`, 'contribution.read');
    }
    await reviewer.grant('space:create:root', 'space.create');
    const realmResponse = await reviewer.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
      name: 'Work review', capabilities: ['realm'], actingSubject: reviewer.actor });
    expect(realmResponse.status).toBe(201);
    const realm = (await realmResponse.json() as { realm: string }).realm;
    await reviewer.grant(`review:decide:${realm}`, 'review.decide');
    await author.grant(`submission:submit:${realm}`, 'submission.submit');
    await stranger.grant(`submission:submit:${realm}`, 'submission.submit');
    const offered = await stack.publicWork(author.actor);
    const candidate = offered.variants[0]!;
    const draft = (await stack.fuseki.query(`SELECT ?draft WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(candidate.decision)} <${RV}selectedDraft> ?draft } }`)).results!.bindings[0]!.draft!.value;
    const submissionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await author.send('POST', `/v1/realms/${short(realm)}/submissions`, {
        actingSubject: author.actor, kind: 'contribution', work: offered.work, mainVersion: offered.mainVersion,
        contribution: candidate.contribution, publicationDecision: candidate.decision, selectedDraft: draft, correctionOf: null });
      expect(response.status).toBe(201);
      submissionIds.push((await response.json() as { submission: { id: string } }).submission.id);
    }

    let measuring = false;
    const statements: Statement[] = [];
    const record = (args: unknown[]) => {
      if (measuring && foregroundCounted() && typeof args[0] === 'string') {
        statements.push({ text: args[0], values: args[1] as unknown[] ?? [] });
      }
    };
    const pool = new Proxy(stack.accessPool, { get(target, key) {
      if (key === 'query') return (...args: unknown[]) => { record(args); return Reflect.apply(target.query, target, args); };
      if (key === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, member) {
          if (member === 'query') return (...args: unknown[]) => { record(args); return Reflect.apply(connection.query, connection, args); };
          const value = Reflect.get(connection, member);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    const index = new TemplateSeekIndex(pool, stack.fuseki);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      templateSeek: index, realmSubmissionReads: new RealmSubmissionReads(pool),
      account: { verify: async request => {
        const member = members.find(person => request.headers.get('authorization') === `Bearer ${person.token}`);
        if (!member) throw new AccountAssertionDenied('Missing bearer');
        return member.principal;
      } } });
    const contributionPath = `/v1/works/${short(work.work)}/contributions`;
    const authorPath = `/v1/my/submissions?work=${encodeURIComponent(offered.work)}`;
    const reviewerPath = `/v1/realms/${short(realm)}/submissions?work=${encodeURIComponent(offered.work)}`;
    const read = (member: Member, path: string, cursor?: string) => app.handle(new Request(
      `http://main.test${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(member.actor)}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: { authorization: `Bearer ${member.token}` } }));
    const all = async <T>(member: Member, path: string) => {
      const items: T[] = [];
      let cursor: string | undefined;
      for (let turn = 0; turn < 10; turn++) {
        const response = await read(member, path, cursor);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const page = await response.json() as Page<T>;
        items.push(...page.items);
        if (!page.nextCursor) return items;
        cursor = page.nextCursor;
      }
      throw new Error('Work page did not terminate');
    };
    const evidence = async () => {
      const snapshots = [];
      for (const [member, path] of [[author, contributionPath], [author, authorPath], [reviewer, reviewerPath]] as const) {
        statements.length = 0;
        const graphBefore = stack.fuseki.queries;
        measuring = true;
        const response = await read(member, path);
        measuring = false;
        const graph = stack.fuseki.queries - graphBefore;
        expect(response.status).toBe(200);
        const page = await response.json() as Page<unknown>;
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeString();
        const sql = statements.length;
        const pageSql = statements.filter(statement => /FROM access\.(template_seek_entry|realm_submission) WHERE/.test(statement.text));
        expect(pageSql).toHaveLength(1);
        const statement = pageSql[0]!;
        const explained = await stack.accessPool.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + statement.text, statement.values);
        const plan = explained.rows[0]['QUERY PLAN'][0].Plan as Plan;
        const workDone = (node: Plan): number => (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']
          + (node.Plans ?? []).reduce((sum, child) => sum + workDone(child), 0);
        expect(workDone(plan), JSON.stringify(plan)).toBeLessThanOrEqual(60);
        snapshots.push({ graph, sql, visited: workDone(plan) });
      }
      return snapshots;
    };
    // Unrelated contributions use the same admitted owner writes as the target.
    // Submission timestamps precede the targets, putting them past the old cap.
    const grow = async (from: number, to: number) => {
      // The public submission candidate contributes one additional draft.
      const count = to - from - (from === 0 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const input = { work: unrelated.work, actingSubject: author.actor, language: 'en', body: `Other draft ${from + i}` };
        const created = await activateTextContribution(stack.env, stack.admission(author.actor,
          `contribution:create:${unrelated.work}`, 'contribution.create', textContributionDigest(input)), input);
        expect(created.outcome).toBe('succeeded');
      }
      await stack.accessPool.query(`INSERT INTO access.realm_submission
        (id, realm, kind, work, main_version, contribution, publication_decision, selected_draft,
          submitting_agent, state, revision, opened_at)
        SELECT gen_random_uuid(), $1, 'contribution', $2, $3, $4, $5, $6, $7, 'pending', gen_random_uuid(),
          '2000-01-01'::timestamptz + n * interval '1 second' FROM generate_series($8::int, $9::int) n`,
      [realm, unrelated.work, unrelated.mainVersion, candidate.contribution, candidate.decision, draft, author.actor, from, to - 1]);
      await stack.accessPool.query('ANALYZE access.realm_submission');
      await stack.accessPool.query('ANALYZE access.template_seek_entry');
    };
    await grow(0, 5);
    const small = await evidence();
    const first = await read(author, contributionPath).then(response => response.json()) as Page<Card>;
    const firstSubmission = await read(author, authorPath).then(response => response.json()) as Page<{ id: string }>;
    await grow(5, 995);
    const large = await evidence();
    expect(large.map(value => [value.graph, value.sql])).toEqual(small.map(value => [value.graph, value.sql]));
    for (let i = 0; i < large.length; i++) expect(large[i]!.visited).toBeLessThanOrEqual(small[i]!.visited + 10);
    // Unrelated growth must not invalidate a continuation for the target Work.
    expect((await read(author, contributionPath, first.nextCursor!)).status).toBe(200);
    expect((await read(author, authorPath, firstSubmission.nextCursor!)).status).toBe(200);
    for (const member of [author, reviewer]) {
      expect((await all<Card>(member, contributionPath)).map(item => item.contribution).sort()).toEqual([...contributions].sort());
    }
    for (const [hiddenPath, absentPath] of [
      [contributionPath, `/v1/works/${randomUUID()}/contributions`],
      [authorPath, `/v1/my/submissions?work=${encodeURIComponent(`https://rezics.com/id/${randomUUID()}`)}`],
      [reviewerPath, `/v1/realms/${randomUUID()}/submissions?work=${encodeURIComponent(offered.work)}`],
      [reviewerPath, `/v1/realms/${short(realm)}/submissions?work=${encodeURIComponent(`https://rezics.com/id/${randomUUID()}`)}`],
    ]) {
      const hidden = await read(stranger, hiddenPath), absent = await read(stranger, absentPath);
      expect(hidden.status).toBe(absent.status);
      expect(comparableBody(await hidden.text())).toBe(comparableBody(await absent.text()));
    }
    expect((await read(stranger, contributionPath)).status).toBe(404);
    // Knowing a visible Work still never confers access to its private drafts.
    await stranger.grant(`work:read:${work.work}`, 'work.read');
    expect(await all<Card>(stranger, contributionPath)).toEqual([]);
    expect((await all<{ id: string }>(author, authorPath)).map(item => item.id).sort()).toEqual([...submissionIds].sort());
    expect((await all<{ id: string }>(reviewer, reviewerPath)).map(item => item.id).sort()).toEqual([...submissionIds].sort());
    expect(await all(stranger, authorPath)).toEqual([]);
    expect((await read(stranger, reviewerPath)).status).toBe(404);
    expect((await read(reviewer, contributionPath, first.nextCursor!)).status).toBe(400);
    const exposed = await read(author, authorPath).then(response => response.text());
    expect(exposed).not.toContain('internalNote');
  } finally { await stack.stop(); }
}, 480_000);
