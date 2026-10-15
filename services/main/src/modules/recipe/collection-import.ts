import { createHash } from 'node:crypto';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { createAdmittedMetadataWork } from '../work/create-admitted.ts';
import { createAdmittedComposition, changeAdmittedComposition } from '../structure/change-admitted.ts';
import { authorPost } from '../post/author.ts';
import { ImportCommands } from '../library-import/batch.ts';
import { ReaderImportConflict, ReaderImportUnavailable } from '../library-import/reader-import.ts';
import { recipeCollectionDigest, type CollectionRecipe } from './collection-file.ts';
import { saveAdmittedContentDraft } from '../content-publication/draft.ts';
import { derivedId } from '../structure/graph.ts';
import type { DocumentNode } from '@rezics/document';
import { structureProfileFor } from '../structure/profiles.ts';
import { resourceTargetReader } from '../target/resolve.ts';

export interface RecipeCollectionOutcome {
  identity: string; status: 'imported'; work: string; structure: string; revision: string;
  content: { post: string; variantId: string; revisionId: string };
  sourceObservation: string; kept: string[]; retainedOnly: string[];
  sourceOmittedFields: string[];
  losses: Array<{ field: string; reason: string }>;
  photos: Array<{ asset: string; representation: string | null; clearance: string; use?: string }>;
  replayed: boolean;
}
const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** One ordinary owner command at a time; deterministic intent keys survive a lost response.
 * Re-importing a changed source is a conflict, never an overwrite of later personal edits. */
export async function importCollectionRecipe(deps: MainWorkDependencies, request: Request,
  actor: string, principalId: string, recipe: CollectionRecipe): Promise<RecipeCollectionOutcome | null> {
  const store = deps.libraryImport;
  if (!store || !deps.sourceIntake) throw new ReaderImportUnavailable('Recipe import owners are unavailable');
  const identity = recipeCollectionDigest([actor, recipe.provider, recipe.identity]);
  const key = `recipe-collection:${identity}`;
  const digest = recipeCollectionDigest(recipe.source);
  const initialized = await store.withBatch(actor, key, async () => {
    await store.beginBatch(actor, key, digest, 1);
    const prior = (await store.outcomes(actor, key)).get(0) as RecipeCollectionOutcome | undefined;
    return { prior };
  }, request.signal);
  if (!initialized) return null;
  if (initialized.prior) return { ...initialized.prior, replayed: true };
  // Owner commands carry deterministic keys. Do not hold a Content connection
  // across Media or graph calls: their transactions own their own checkouts.
  const step = (name: string) => `${key}:${name}`;
  // No own-work author credit: custody of an imported recipe is not authorship.
  const created = await createAdmittedMetadataWork(deps.environment, deps.account, deps.access, request,
    { actingSubject: actor, title: recipe.title, language: recipe.language,
      semanticTypes: [structureProfileFor('recipe-composition').ownerType], idempotencyKey: step('work') });
  const composition = await createAdmittedComposition(deps.environment, deps.account, deps.access, request,
    { profile: 'recipe-composition', work: created.work, mainVersion: created.mainVersion,
      actingSubject: actor, idempotencyKey: step('structure') });
  if (!composition.revision || !composition.structure) throw new ReaderImportUnavailable('Recipe composition is pending');
  const structure = composition.structure;
  const retained = await deps.sourceIntake!.submit(principalId, step('source'), {
    provider: recipe.provider, namespace: 'recipe-collection', externalId: identity,
    sourceRevision: digest, mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: Buffer.from(JSON.stringify(recipe.retainedSource)).toString('base64'),
    coverage: { scope: 'recipe-collection', complete: recipe.sourceOmittedFields.length === 0,
      omittedFields: recipe.sourceOmittedFields },
    rightsEvidence: { basis: 'unknown', note: 'Private user-supplied recipe export; import does not grant publication rights.' },
  });
  const post = await authorPost(deps, request, { actingSubject: actor,
    title: { value: recipe.title, language: recipe.language }, language: recipe.language,
    document: recipe.document, privateImport: { sourceObservation: retained.observation.observation,
      sourceDigest: retained.observation.byteDigest! } }, step('content'));
  let revision = composition.revision;
  for (let offset = 0; offset < recipe.parsed.ingredients.length; offset += 16) {
    const result = await changeAdmittedComposition(deps.environment, deps.account, deps.access, request,
      { structure, actingSubject: actor, expectedHead: revision,
        idempotencyKey: step(`ingredients-${offset}`), operations: recipe.parsed.ingredients.slice(offset, offset + 16)
          .map(item => ({ op: 'insert' as const, role: 'ingredient' as const, parent: structure,
            position: 'last', qualifier: item.qualifier, sourceKey: item.sourceKey })) });
    if (!result.revision) throw new ReaderImportUnavailable('Recipe ingredients are pending');
    revision = result.revision;
  }
  const kept = ['title', 'source', ...(['ingredients', 'notes', recipe.provider === 'paprika' ? 'directions' : 'instructions']
    .filter(field => typeof recipe.source[field] === 'string' && recipe.source[field])
    .map(field => field === 'directions' ? 'instructions' : field))];
  const losses: RecipeCollectionOutcome['losses'] = [];
  // Category shelves use the Library's existing private, idempotent placement owner.
  const commands = new ImportCommands(store, request, { actingSubject: actor, language: recipe.language,
    context: null, existingShelves: [], rows: [] }, key);
  const shelves = new Map<string, string>();
  for (const name of recipe.categories) {
    const result = await commands.shelf(created.work, name, shelves, { status: { status: null,
      startedOn: null, finishedOn: null, version: 0 }, rating: { global: null }, customShelves: [] });
    if (result === 'retry' || result === 'stale') throw new ReaderImportUnavailable('Recipe category placement is pending');
    if (result === 'failed') losses.push({ field: 'categories', reason: 'collection-owner-refused' });
  }
  if (recipe.categories.length && !losses.length) kept.push('categories');
  const photos: RecipeCollectionOutcome['photos'] = [];
  const imageBlocks: DocumentNode[] = [];
  for (const [index, encoded] of recipe.photos.entries()) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      losses.push({ field: `photos/${index}`, reason: 'invalid-base64' }); continue;
    }
    const bytes = Buffer.from(encoded, 'base64');
    const mediaType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii', 0, 3) === 'GIF' ? 'image/gif'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!mediaType || bytes.toString('base64') !== encoded) {
      losses.push({ field: `photos/${index}`, reason: 'unsupported-image' }); continue;
    }
    const reserved = await commands.call('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1',
      asset: null, mediaType, byteLength: bytes.length, sha256: hashBytes(bytes),
      disclosure: 'private', actingSubject: actor }, step(`photo-${index}`));
    if (reserved.status >= 500 || reserved.status === 429) throw new ReaderImportUnavailable('Recipe photo owner is unavailable');
    if (!reserved.ok) { losses.push({ field: `photos/${index}`, reason: 'media-owner-refused' }); continue; }
    const upload = await reserved.json() as { upload: string; asset: string };
    const activated = await store.call(new Request(`http://main.local/v1/media/uploads/${upload.upload}/bytes`, {
      method: 'PUT', signal: request.signal, headers: { authorization: request.headers.get('authorization') ?? '',
        'content-type': mediaType }, body: bytes }));
    if (activated.status >= 500 || activated.status === 429) throw new ReaderImportUnavailable('Recipe photo owner is unavailable');
    if (!activated.ok) { losses.push({ field: `photos/${index}`, reason: 'media-rejected' }); continue; }
    const photo = await activated.json() as { asset: string; representation: string | null; clearance: string };
    const image: RecipeCollectionOutcome['photos'][number] = { asset: photo.asset,
      representation: photo.representation, clearance: photo.clearance };
    photos.push(image);
    kept.push(`photos/${index}`);
    if (photo.representation) {
      const occurrence = derivedId(`${actor}:${key}:photo:${index}`).slice(-36);
      const linked = await commands.call('POST', '/v1/media/uses', { actingSubject: actor,
        target: post.post, representation: photo.representation, occurrence }, step(`photo-use-${index}`));
      if (linked.status >= 500 || linked.status === 429) throw new ReaderImportUnavailable('Recipe photo binding is unavailable');
      if (!linked.ok) { losses.push({ field: `photos/${index}`, reason: 'media-kept-without-content-binding' }); continue; }
      const use = await linked.json() as { use: string };
      image.use = use.use;
      imageBlocks.push({ type: 'image', attrs: { id: occurrence,
        src: `/v1/media/representations/${photo.representation}/bytes?use=${use.use}`,
        representationId: photo.representation, mediaUseId: use.use, alt: '' } });
    }
  }
  let contentRevision = post.revisionId;
  if (imageBlocks.length) {
    const saved = await saveAdmittedContentDraft(deps.environment, deps.contentAuthoring!, deps.account,
      deps.access, request, { resourceId: post.post, variant: { id: post.variantId, resourceId: post.post,
        language: { kind: 'tag', tag: recipe.language, originalTag: recipe.language }, direction: 'ltr' },
        actingSubject: actor, expectedHead: post.revisionId, idempotencyKey: step('content-images'),
        privateImport: { sourceObservation: retained.observation.observation, sourceDigest: retained.observation.byteDigest! },
        document: { ...recipe.document, doc: { type: 'doc', content: [...recipe.document.doc.content!, ...imageBlocks] } } });
    if (!saved.revisionId) throw new ReaderImportUnavailable('Recipe photo Content is pending');
    contentRevision = saved.revisionId;
  }
  const instruction = await changeAdmittedComposition(deps.environment, deps.account, deps.access, request,
    { structure, actingSubject: actor, expectedHead: revision,
      idempotencyKey: step('instructions'), operations: [{ op: 'insert', role: 'instruction',
        parent: structure, position: 'last', sourceKey: 'recipe-collection:content',
        target: post.post, selection: { mode: 'fixed-revision', revision: contentRevision,
          selector: { grain: 'content', variantId: post.variantId, revision: contentRevision } } }] },
    resourceTargetReader(deps, request, actor));
  if (!instruction.revision) throw new ReaderImportUnavailable('Recipe instructions are pending');
  revision = instruction.revision;
  // B02 owns native score scales. Never round or publish a private source score.
  const retainedOnly = [...recipe.retainedOnly, ...(recipe.rating !== undefined ? ['rating'] : [])];
  const outcome: RecipeCollectionOutcome = { identity: recipe.identity, status: 'imported', work: created.work,
    structure, revision, content: { post: post.post, variantId: post.variantId,
      revisionId: contentRevision }, sourceObservation: retained.observation.observation,
    kept, retainedOnly, sourceOmittedFields: recipe.sourceOmittedFields, losses, photos, replayed: false };
  await store.recordOutcome(actor, key, 0, outcome);
  return outcome;
}

export const collectionRecipeConflict = (error: unknown) => error instanceof ReaderImportConflict;
