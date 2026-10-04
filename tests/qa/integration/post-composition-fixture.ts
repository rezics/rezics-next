import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { WorkActivationEnvironment, WorkActivationReceipt } from '../../../services/main/src/modules/work/activate.ts';

const stores = new WeakMap<WorkActivationEnvironment, S3ImmutableObjects>();
const short = (value: string) => value.slice(-36);
async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Post fixture: ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

/** Rights fixtures use the same Post/placement command as Studio. */
export async function fixtureChapter(env: WorkActivationEnvironment,
  send: (path: string, body: object) => Promise<Response>,
  grant: (actor: string, scope: string, action: string) => Promise<unknown>,
  book: WorkActivationReceipt, actor: string, grouped = false) {
  let objects = stores.get(env);
  if (!objects) {
    objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/' });
    await objects.initialize();
    Object.assign(env, { structureObjects: objects });
    stores.set(env, objects);
  }
  await grant(actor, `work:edit:${book.work}`, 'work.edit');
  const composition = await json<{ structure: string; revision: string }>(await send('/v1/compositions', {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: actor }), 201);
  let parent = composition.structure, head = composition.revision;
  if (grouped) {
    const group = await json<{ revision: string; occurrences: string[] }>(await send(
      `/v1/compositions/${short(composition.structure)}/changes`, { profile: 'book-composition', expectedHead: head,
        actingSubject: actor, operations: [{ op: 'insert', role: 'group', parent, position: 'last',
          division: 'volume', label: { value: 'Volume', language: 'en' } }] }), 200);
    head = group.revision; parent = group.occurrences[0]!;
  }
  const post = await json<{ post: string; revision: string }>(await send(`/v1/works/${short(book.work)}/chapters`, {
    profile: 'book-chapter-create-v1', title: 'Chapter', language: 'en', direction: 'ltr', parent,
    position: 'last', expectedCompositionHead: head, actingSubject: actor }), 200);
  for (const [prefix, action] of [['work:read', 'work.read'], ['content:draft', 'content.draft'],
    ['content:publish', 'content.publish'], ['content:search-eligibility', 'content.search-eligibility']] as const) {
    await grant(actor, `${prefix}:${post.post}`, action);
  }
  return { ...book, work: post.post, workRevision: post.revision };
}
