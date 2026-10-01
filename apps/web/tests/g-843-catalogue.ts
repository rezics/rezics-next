// The records the G-843 e2e searches, written once into the isolated QA stack through Main's catalogue
// routes (search first, then create with the receipt), as a contributor would: Sword Art Online and its
// first volume, each with a Japanese alias and, for the series, a romanization. The browser signs in as
// the stack's web member, who may add records and edit the volume.
import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import type { MediaStack } from '../../../tests/qa/integration/media-support.ts';

/** The real web member the browser signs in as. */
export interface SeedReader { principalId: string; actor: string }
interface Created { work: string; mainVersion: string; workRevision: string }
export interface IntakeCatalogue { series: Created & { title: string }; volumeOne: Created & { title: string } }

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

export async function seedIntakeCatalogue(stack: MediaStack, reader: SeedReader): Promise<IntakeCatalogue> {
  const editor = await stack.member('catalogue');
  await editor.grant('work:create:root', 'work.create');
  const grantReader = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.actor, scope, action]);
  };
  // The web member adds records from the wizard: Access admits the creation like any contributor's.
  await grantReader('work:create:root', 'work.create');

  const catalogueIntake = new CatalogueIntakeStore(stack.accessPool, stack.env);
  const deps: MainWorkDependencies = { environment: stack.env, access: stack.access, media: stack.media, catalogueIntake,
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (token !== editor.token) throw new AccountAssertionDenied('Unknown seed bearer');
      return editor.principal;
    } } };
  const app = createMainApp(stack.fuseki, deps);
  const send = (path: string, body: unknown) => app.handle(new Request(`http://main.local${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${editor.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body) }));

  const create = async (title: string, aliases: { value: string; language: string }[],
    romanizations: { value: string; language: string }[]): Promise<Created & { title: string }> => {
    const searched = await json<{ candidateReceipt: string }>(await send('/v1/catalogue/candidates', {
      profile: 'catalogue-candidates-v1', originalTitle: { value: title, language: 'en' }, aliases, romanizations,
      creators: [], dates: [], identifiers: [] }));
    const created = await json<Created>(await send('/v1/works', { profile: 'metadata-only-v1', title, language: 'en',
      actingSubject: editor.actor, grain: 'new-creative-scope', candidateReceipt: searched.candidateReceipt,
      aliases, romanizations, semanticTypes: ['https://schema.org/Book'] }), 201);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    await editor.grant(`work:read:${created.work}`, 'work.read');
    await grantReader(`work:read:${created.work}`, 'work.read');
    await grantReader(`work:edit:${created.work}`, 'work.edit');
    return { ...created, title };
  };

  const series = await create('Sword Art Online', [{ value: 'ソードアート・オンライン', language: 'ja' }],
    [{ value: 'Sōdo Āto Onrain', language: 'ja-Latn' }]);
  const volumeOne = await create('Sword Art Online, Vol. 1', [{ value: 'ソードアート・オンライン 1', language: 'ja' }], []);
  return { series, volumeOne };
}
