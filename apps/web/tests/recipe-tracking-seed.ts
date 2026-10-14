import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../../../tests/qa/fixtures/author-credit.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';

export interface RecipeTrackingFixture { work: string; title: string }
const run = process.env.REZICS_QA_RUN_ID ?? '';
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(run)) throw new Error('Use isolated browser QA');
const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
if (!authPath) throw new Error('The browser member is required');
const reader = JSON.parse(readFileSync(authPath, 'utf8')) as { principalId: string; actingSubject: string };
const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp/recipe-tracking', run));
const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
  region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
  prefix: 'semantic/structure/' });
await objects.initialize();
Object.assign(f.env, { structureObjects: objects });
try {
  const answer = async <T>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
    const response = await f.call(method, path, body);
    const text = await response.text();
    if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const title = 'Measured pancakes';
  const work = await answer<{ work: string; mainVersion: string }>('POST', '/v1/works', await f.authoredBody({
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
  }), 201);
  const short = (iri: string) => iri.slice(-36);
  await f.grant(`work:edit:${work.work}`, 'recipe.edit');
  await f.grant(`work:read:${work.work}`, 'work.read');
  const composition = await answer<{ structure: string; revision: string }>('POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: f.actor,
  }, 201);
  const changed = await answer<{ revision: string }>('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: composition.revision, actingSubject: f.actor,
    operations: [
      { op: 'insert', parent: composition.structure, position: 'last', role: 'ingredient', qualifier: {
        type: 'ingredient-line', originalText: { value: '1 cup flour', language: 'en' }, amountLexical: '1',
        amount: { numerator: 1, denominator: 1 }, unitText: 'cup', optional: false, scaling: 'linear',
        substituteFor: [], parseStatus: 'parsed',
      } },
      { op: 'insert', parent: composition.structure, position: 'last', role: 'step', qualifier: {
        type: 'recipe-step', instructionText: { value: 'Cook the pancakes until golden.', language: 'en' },
        usesIngredient: [], media: [], scaling: 'linear',
      } },
    ],
  });
  const head = await answer<{ revision: string }>('GET', `/v1/works/${short(work.work)}/scalar-value?actingSubject=${encodeURIComponent(f.actor)}`);
  await answer('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
    actingSubject: f.actor, expectedWorkHead: head.revision, expectedMainVersion: work.mainVersion,
    structure: composition.structure, expectedStructureHead: changed.revision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public',
  }, 201);
  await grantFixtureAuthority(f.accessPool, { scope: `work:read:${work.work}`, requireDispatch: true,
    representations: [{ principalId: reader.principalId, actor: reader.actingSubject, action: 'work.read', lifetime: '8 hours' }],
    grant: { actor: reader.actingSubject, action: 'work.read', lifetime: '8 hours' } });
  const directory = resolve('.temp/recipe-tracking', run);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'seed.json'), JSON.stringify({ work: work.work, title } satisfies RecipeTrackingFixture));
} finally {
  await f.close();
}
