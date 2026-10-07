// Seeds the series the episode-progress journey reads into the isolated QA stack the e2e harness
// started, and prints its IDs as JSON: twelve episodes and a group of two specials. Every record
// goes in through Main's routes; the signed-in web member reads them by explicit grants, like the
// other journey seeds.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';

const short = (iri: string) => iri.slice(-36);
const types = ['https://schema.org/TVSeries'];
const OPERATIONS = 16;

export interface Series { work: string; title: string; episodes: number; specials: number }
export const series = { title: 'Moonlit Courier', episodes: 12, specials: 2 } as const;

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

/** Main keeps projecting earlier writes while the seed goes on; a write told to restart is sent again. */
async function settled(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 409 || attempt === 40 || !(await response.clone().text()).includes('read_basis_changed')) return response;
    await new Promise(done => setTimeout(done, 500));
  }
}

export async function seedSeries(stack: MediaStack, reader: { principalId: string; actor: string }, plan: typeof series): Promise<Series> {
  const editor = await stack.member('episodes');
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });

  /** Self-held grants, many scopes in one statement. */
  const grantAll = async (who: { principalId: string; actor: string }, action: string, scopes: string[]) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [scopes]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), who.principalId, who.actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      SELECT gen_random_uuid(), $1, $1, scope, $2, now() + interval '8 hours' FROM unnest($3::text[]) AS scope`, [who.actor, action, scopes]);
  };
  const grantEditor = (action: string, scopes: string[]) => grantAll(editor, action, scopes);
  const grantReader = (action: string, scopes: string[]) => grantAll(reader, action, scopes);

  const created = await activateMetadataWork(stack.env, { title: plan.title, semanticTypes: types, admission: stack.admission(
    editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(plan.title, types)) });
  const text = await stack.contribution(created.work, editor.actor, 'ja', `${plan.title}（本文）`);
  const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
    contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
  const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
    `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
  if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${plan.title}`);
  await grantEditor('work.edit', [`work:edit:${created.work}`]);
  await grantEditor('work.read', [`work:read:${created.work}`]);
  await grantReader('work.read', [`work:read:${created.work}`]);
  await editor.grant('semantic:create:root', 'semantic.change');

  const started = performance.now();
  const lap = (name: string) => console.error(`[episode seed ${plan.title}] ${name}: ${Math.round(performance.now() - started)} ms`);

  // Main takes writes one at a time, so the episodes are written one after the other.
  const total = plan.episodes + plan.specials;
  const resources: string[] = [];
  for (let index = 0; index < total; index++) {
    const special = index >= plan.episodes;
    const number = special ? index - plan.episodes + 1 : index + 1;
    const episode = await json<{ component: string }>(await settled(() => editor.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor.actor,
      state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `${special ? 'Special' : 'Episode'} ${number}`, language: 'en' } },
        { predicate: 'https://schema.org/episodeNumber', value: { kind: 'integer', lexical: String(number) } }] } })), 201);
    resources.push(episode.component);
  }
  const scopes = resources.map(resource => `semantic:read:${resource}`);
  await grantEditor('semantic.read', scopes);
  await grantReader('semantic.read', scopes);
  lap('episode resources');
  const resourceAt = (index: number) => resources[index]!;

  /** The series' Structure: the main run in order, then a Specials group. */
  const composition = await json<{ structure: string; revision: string }>(await settled(() => editor.send('POST', '/v1/compositions', {
    profile: 'work-composition', work: created.work, mainVersion: created.mainVersion, actingSubject: editor.actor })), 201);
  const path = `/v1/compositions/${short(composition.structure)}/changes`;
  let head = composition.revision;
  const change = async (operations: object[]) => {
    const written = await json<{ revision: string; occurrences: string[] }>(await settled(() => editor.send('POST', path, {
      profile: 'work-composition', expectedHead: head, actingSubject: editor.actor, operations })));
    head = written.revision;
    return written;
  };
  const part = (parent: string, target: string, label: string, inclusion: 'required' | 'extra') =>
    ({ op: 'insert', parent, position: 'last', role: 'part', target, displayLabel: label, inclusion });
  for (let at = 0; at < plan.episodes; at += OPERATIONS) {
    await change(Array.from({ length: Math.min(OPERATIONS, plan.episodes - at) }, (_, index) =>
      part(composition.structure, resourceAt(at + index), `Episode ${at + index + 1}`, 'required')));
  }
  if (plan.specials) {
    const group = await change([{ op: 'insert', parent: composition.structure, position: 'last', role: 'group',
      label: { value: 'Specials', language: 'en' } }]);
    await change(Array.from({ length: plan.specials }, (_, index) =>
      part(group.occurrences[0]!, resourceAt(plan.episodes + index), `Special ${index + 1}`, 'extra')));
  }
  lap('composed');
  return { ...plan, work: created.work };
}

if (import.meta.main) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
    throw new Error('The episode seed writes only into an isolated QA run');
  }
  const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
  const { principalId, actingSubject } = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };
  const stack = await startMediaStack('episodes-e2e');
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  Object.assign(stack.env, { objectDirectory, workObjects });
  try {
    console.log(JSON.stringify(await seedSeries(stack, { principalId, actor: actingSubject }, series)));
  } finally {
    await stack.stop();
  }
}
