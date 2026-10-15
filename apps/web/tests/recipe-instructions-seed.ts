import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { document, paragraph, type BlocksDocument, type ResourceReference } from '../../../scripts/qa/cases/outcomes/recipes/instructions-in-any-form.ts';
import { platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { settledWrite } from '../../../tests/qa/support/settled-write.ts';

export interface RecipeInstructionsFixture {
  recipes: { form: 'procedure' | 'post' | 'audio'; title: string; work: string; text?: string }[];
  recordingDigest: string;
}

const run = process.env.REZICS_QA_RUN_ID ?? '';
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(run)) throw new Error('Use an isolated browser QA run');
const session = await platformAdministratorSession(process.env, 'openid work:create work:edit work:read');
const actor = session.actingSubject;
const short = (iri: string) => iri.slice(-36);
const main = async (method: string, path: string, body?: unknown, key?: string) => fetch(new URL(path, session.mainOrigin), {
  method, headers: { authorization: `Bearer ${await session.session.current()}`,
    ...(key ? { 'idempotency-key': key } : {}),
    ...(body ? { 'content-type': body instanceof Uint8Array ? 'audio/wav' : 'application/json' } : {}) },
  ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
});
async function answer<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await settledWrite(main, method, path, body);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

// Only authority is a fixture write. Every Recipe, Post, Content and recording
// is authored and published through the production owners.
const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const action of ['media.upload', 'media.manage']) {
    await grantFixtureAuthority(client, { scope: `media:owner:${actor}`, requireDispatch: true,
      representations: [{ principalId: session.principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' } });
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }

async function work(title: string, type: 'Book' | 'Recipe') {
  return answer<{ work: string; mainVersion: string; workRevision: string }>('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: [`https://schema.org/${type}`],
    authoring: 'own-work', actingSubject: actor,
  });
}
async function post(title: string, value: BlocksDocument): Promise<ResourceReference> {
  const book = await work(`${title} notebook`, 'Book');
  const composition = await answer<{ structure: string; revision: string }>('POST', '/v1/compositions', {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: actor,
  });
  const created = await answer<{ post: string; variantId: string }>('POST', `/v1/works/${short(book.work)}/chapters`, {
    profile: 'book-chapter-create-v1', title, language: 'en', direction: 'ltr', parent: composition.structure,
    position: 'last', expectedCompositionHead: composition.revision, actingSubject: actor,
  });
  const content = await answer<{ revisionId: string }>('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: created.post, variantId: created.variantId, expectedHead: null,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', document: value, actingSubject: actor,
  });
  return { target: created.post, selector: { grain: 'content', variantId: created.variantId, revision: content.revisionId } };
}
const procedureText = 'Stir the drained tomatoes into the stock.';
const procedure = await post('Structured tomato procedure', document([{ type: 'extensionBlock', attrs: {
  id: 'procedure', definition: 'https://rezics.com/definition/procedure-v1', version: '1',
  payload: { items: [{ id: 'sauce', type: 'HowToSection', name: { value: 'Sauce method', language: 'en' },
    items: [{ id: 'stir', type: 'HowToStep', document: document([paragraph('stir', procedureText)]) }] }] },
  fallback: 'Sauce method: stir the drained tomatoes into the stock.',
} }]));
const postText = 'Fold the fresh basil into the warm sauce.';
const prose = await post('Basil method Post', document([paragraph('fold', postText)]));
const bytes = readFileSync(new URL('../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url));
const recordingDigest = createHash('sha256').update(bytes).digest('hex');
const reserved = await answer<{ asset: string; upload: string }>('POST', '/v1/media/uploads', {
  profile: 'media-recording-upload-v1', asset: null, mediaType: 'audio/wav', byteLength: bytes.byteLength,
  sha256: recordingDigest, disclosure: 'private', actingSubject: actor,
});
const recording = await answer<{ representation: string; revision: string }>('PUT', `/v1/media/uploads/${reserved.upload}/bytes`, bytes);
const audio: ResourceReference = { target: `urn:rezics:media:asset:${reserved.asset}`,
  selector: { grain: 'representation', revision: recording.revision, representation: recording.representation } };
const recipes: RecipeInstructionsFixture['recipes'] = [];
for (const [form, reference, text] of [['procedure', procedure, procedureText], ['post', prose, postText], ['audio', audio, undefined]] as const) {
  const title = `Original tomato instructions: ${form}`;
  const recipe = await work(title, 'Recipe');
  const composition = await answer<{ structure: string; revision: string }>('POST', '/v1/compositions', {
    profile: 'recipe-composition', work: recipe.work, mainVersion: recipe.mainVersion, actingSubject: actor,
  });
  const changed = await answer<{ revision: string }>('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: composition.revision, actingSubject: actor,
    operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'instruction', target: reference.target,
      selection: { mode: 'fixed-revision', revision: 'revision' in reference.selector ? reference.selector.revision : '', selector: reference.selector } }],
  });
  await answer('POST', '/v1/work-publications', { profile: 'work-structure-publication-v1', operation: 'publish',
    work: recipe.work, expectedWorkHead: recipe.workRevision, expectedMainVersion: recipe.mainVersion,
    structure: composition.structure, expectedStructureHead: changed.revision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor });
  recipes.push({ form, title, work: recipe.work, ...(text ? { text } : {}) });
}
const directory = resolve('.temp/recipe-instructions', run);
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'seed.json'), JSON.stringify({ recipes, recordingDigest } satisfies RecipeInstructionsFixture));
