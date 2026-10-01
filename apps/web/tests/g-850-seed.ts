// Seeds the G-850 records into the isolated QA stack the e2e harness started and prints their IDs as JSON:
// the G-838 franchise records (Sword Art Online as a series of three volumes with a paperback, an audiobook
// and an omnibus; Index; Spider), a global rating question and one review of the Sword Art Online series by
// another reader. The browser signs in as the stack's web member (private web-auth fixture).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { type Catalogue, seedCatalogue } from './g-838-catalogue.ts';
import { globalRatingContext } from './global-rating-context.ts';

export interface Hub extends Catalogue { review: { text: string; reviewer: string } }

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-850 seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
const { principalId, actingSubject } = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };

async function created<T>(response: Response, status = 201): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Seed step failed with ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const stack = await startMediaStack('g850-e2e');
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const catalogue = await seedCatalogue(stack, { principalId, actor: actingSubject }, resolve('.temp', `g850-${process.env.REZICS_QA_RUN_ID}`));
  const series = catalogue.sao.series;

  // The question everyone's ratings answer, and a reader who rated the series and reviewed it. Reviews and the
  // person Agent they need are written through their own owners, which the stack's default app leaves out.
  const owner = await stack.member('hub-context');
  const global = { context: await globalRatingContext(owner, series.work, 'How good is this Work overall?') };
  const account = await stack.member('hub-reviewer');
  const principals = new Map<string, typeof account.principal>([[account.token, account.principal]]);
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
    account: { verify: async (request: Request) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new AccountAssertionDenied('Authentication required');
      const verified = { ...principal, emailVerified: true };
      return { ...verified, currentAssertion: async () => verified };
    } },
    agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
    reviews: new ReaderReviews(stack.accessPool), libraryStatus: new ReaderLibraryStatusStore(stack.contentPool) });
  const call = (method: string, path: string, body: unknown) => app.handle(new Request(`http://main.local${path}`, { method,
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body) }));
  const { agent } = await created<{ agent: string }>(await call('POST', '/v1/agents',
    { profile: 'agent-provision-v1', kind: 'person', displayName: 'Hub reviewer' }));
  const grant = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), account.principalId, agent, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), agent, scope, action]);
  };
  await grant(`rating:observe:${global.context}`, 'rating.observation.set');
  await created(await call('POST', '/v1/global-rating-observations', {
    profile: 'global-rating-standing-observation-v1', context: global.context, work: series.work,
    mainVersion: series.mainVersion, expectedRevisionHead: null, value: 5, actingSubject: agent }));
  const text = 'Aincrad is a tower and a trap; the first volume never lets you forget which.';
  await created(await call('POST', '/v1/reviews', { profile: 'reader-review-command-v1', actingSubject: agent,
    context: global.context, target: series.work, expectedRevision: null, language: 'en', text, spoiler: false }));

  const hub: Hub = { ...catalogue, review: { text, reviewer: agent } };
  console.log(JSON.stringify(hub));
} finally {
  await stack.stop();
}
