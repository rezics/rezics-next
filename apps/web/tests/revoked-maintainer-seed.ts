// A recipe whose owner has added a co-maintainer, written into the QA stack the
// browser journey signs in to. The editor opens as that co-maintainer.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { studioSegment, workHref } from '../features/studio/agent.ts';
import { recipeEditHref } from '../features/recipe-editor/route.ts';
import { localizedPath } from '../i18n/locale.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The revoked-maintainer seed writes only into an isolated QA run');
}
const publicPath = process.env.REZICS_WEB_AUTH_PUBLIC_PATH;
const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!publicPath || !privatePath) throw new Error('The browser QA stack’s web auth fixtures are required');

const site = JSON.parse(readFileSync(publicPath, 'utf8')) as {
  issuer: string; authorizationEndpoint: string; tokenEndpoint: string; resource: string;
  clientId: string; redirectUris: string[]; scope: string; actingSubject: string; mainBaseUrl: string;
};
const member = JSON.parse(readFileSync(privatePath, 'utf8')) as { member: { email: string; password: string } };
const account = new URL(site.issuer).origin;
const signedIn = await fetch(`${account}/api/auth/sign-in/email`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: account },
  body: JSON.stringify({ email: member.member.email, password: member.member.password }),
});
if (signedIn.status !== 200) throw new Error(`Account sign-in failed (${signedIn.status})`);
const session = await signIn({
  account, clientId: site.clientId, redirectUri: site.redirectUris[0]!, scope: site.scope,
  resource: site.resource, tokenEndpoint: site.tokenEndpoint,
  authorizeEndpoint: site.authorizationEndpoint,
}, signedIn.headers.get('set-cookie')!);
const token = await session.current();

async function send(path: string, body: unknown, key = randomUUID()): Promise<{ status: number; body: Record<string, unknown> }> {
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${site.mainBaseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    last = await response.text();
    if (response.status === 202 || response.status >= 500) {
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      continue;
    }
    return { status: response.status, body: last ? JSON.parse(last) as Record<string, unknown> : {} };
  }
  throw new Error(`POST ${path} did not settle: ${last.slice(0, 500)}`);
}

const owner = site.actingSubject;
const pen = await send('/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName: 'Recipe co-maintainer' });
if (pen.status !== 201 && pen.status !== 200) throw new Error(`Co-maintainer was not created (${pen.status}): ${JSON.stringify(pen.body).slice(0, 500)}`);
const coMaintainer = pen.body.agent as string;
const work = await send('/v1/works', {
  profile: 'metadata-only-v1', authoring: 'own-work', language: 'en',
  title: `Revoked editor ${randomUUID().slice(0, 8)}`, semanticTypes: ['https://schema.org/Recipe'],
  actingSubject: owner,
});
if (work.status !== 201) throw new Error(`Recipe was not created (${work.status}): ${JSON.stringify(work.body).slice(0, 500)}`);
const workIri = work.body.work as string;
const listed = await fetch(`${site.mainBaseUrl}/v1/works/${workIri.slice(-36)}/maintainers`, {
  headers: { authorization: `Bearer ${token}` },
});
const members = await listed.json() as { generation: string };
if (listed.status !== 200) throw new Error(`Maintainers were not readable (${listed.status})`);
const added = await send('/v1/work-maintainer-changes', {
  profile: 'work-maintainer-change-v1', work: workIri, actingSubject: owner, target: coMaintainer,
  action: 'add', expectedGeneration: members.generation,
});
if (added.status !== 201) throw new Error(`Co-maintainer was not added (${added.status}): ${JSON.stringify(added.body).slice(0, 500)}`);
const composition = await send('/v1/compositions', {
  profile: 'recipe-composition', work: workIri, mainVersion: work.body.mainVersion, actingSubject: owner,
});
if (composition.status !== 201) throw new Error(`Recipe composition was not created (${composition.status}): ${JSON.stringify(composition.body).slice(0, 500)}`);

const editorPath = localizedPath(
  `${recipeEditHref(workIri.slice(-36))}?agent=${encodeURIComponent(studioSegment({ iri: coMaintainer, handle: null }))}`,
  'en');
const panelPath = localizedPath(workHref({ iri: owner, handle: null }, workIri, 'details'), 'en');
const directory = resolve('.temp/revoked-maintainer', process.env.REZICS_QA_RUN_ID!);
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'seed.json'), JSON.stringify({
  work: workIri, owner, pen: coMaintainer, generation: added.body.generation, editorPath, panelPath,
}, null, 2) + '\n');
console.log(editorPath);
