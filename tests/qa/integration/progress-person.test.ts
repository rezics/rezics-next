import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('two principals of one Person share chapter progress; another Person and anonymous callers cannot read or change it', async () => {
  const stack = await startMediaStack('progress-person');
  const progress = new StructureProgressStore(stack.contentPool, { automaticOrderProjection: false });
  try {
    const first = await stack.member('first-sign-in'), second = await stack.member('second-sign-in');
    const stranger = await stack.member('another-person');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    stack.access.configureBaseline(stack.fuseki);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      progress, structureObjects: objects, media: stack.media, mediaAccess: stack.mediaAccess,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async request => {
        const member = [first, second, stranger].find(item => `Bearer ${item.token}` === request.headers.get('authorization'));
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        const principal = { ...member.principal, emailVerified: true };
        return { ...principal, currentAssertion: async () => principal };
      } } });
    const call = (token: string, method: string, path: string, body?: object, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        authorization: `Bearer ${token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const person = async (token: string, name: string) => (await json<{ agent: string }>(await call(token,
      'POST', '/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName: name }), 201)).agent;
    const reader = await person(first.token, 'Reader'), other = await person(stranger.token, 'Other reader');
    const control = await stack.accessPool.connect();
    try {
      await control.query('BEGIN');
      await grantFixtureAuthority(control, { scope: `agent:control:${reader}`, requireDispatch: false,
        representations: [{ principalId: second.principalId, actor: reader, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: reader, action: 'agent.control', lifetime: 'infinity' } });
      await control.query('COMMIT');
    } catch (error) { await control.query('ROLLBACK'); throw error; }
    finally { control.release(); }
    const title = 'Shared progress book', types = ['https://schema.org/Book'];
    const book = await activateMetadataWork(stack.env, { title, semanticTypes: types,
      admission: stack.admission(first.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(book.work, first.actor, 'en', 'A fictional book about a paper boat.');
    const selection = { context: { kind: 'main-version-default' as const, id: book.mainVersion }, work: book.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: first.actor };
    await selectMainDefault(stack.env, stack.admission(first.actor, `publication:select:${book.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    await first.grant(`work:read:${book.work}`, 'work.read');
    await first.grant(`work:edit:${book.work}`, 'work.edit');
    const base = await json<{ structure: string; revision: string }>(await call(first.token, 'POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: first.actor }), 201);
    const changed = await json<{ occurrences: string[] }>(await call(first.token, 'POST',
      `/v1/compositions/${short(base.structure)}/changes`, { profile: 'book-composition', expectedHead: base.revision,
        actingSubject: first.actor, operations: [{ op: 'insert', parent: base.structure, role: 'chapter', position: 'last',
          target: 'https://schema.org/DigitalDocument', label: { value: 'Chapter one', language: 'en' } }] }));
    const occurrence = changed.occurrences[0]!;
    const path = `/v1/compositions/${short(base.structure)}/occurrences/${short(occurrence)}/progress`;
    const own = `?actingSubject=${encodeURIComponent(reader)}`, theirs = `?actingSubject=${encodeURIComponent(other)}`;
    const command = { actingSubject: reader, completed: false, position: 'paragraph:4', expectedVersion: 0 };
    expect(await json(await call(first.token, 'PUT', path, command))).toMatchObject({ version: 1, position: 'paragraph:4' });
    expect(await json(await call(second.token, 'GET', path + own))).toMatchObject({ version: 1, position: 'paragraph:4' });
    await json(await call(second.token, 'PUT', path, { ...command, expectedVersion: 1, completed: true, position: null }));
    expect(await json(await call(first.token, 'GET', path + own))).toMatchObject({ version: 2, completed: true });
    expect((await call(first.token, 'PUT', path, command)).status).toBe(409);
    const page = `/v1/compositions/${short(base.structure)}/progress`;
    expect(await json(await call(second.token, 'GET', page + own))).toMatchObject({ items: [{ occurrence, completed: true }] });
    expect(await json(await call(stranger.token, 'GET', path + theirs))).toMatchObject({ version: 0, position: null });
    expect(await json(await call(stranger.token, 'GET', page + theirs))).toMatchObject({ items: [] });
    for (const token of [stranger.token, '']) {
      expect((await call(token, 'GET', path + own)).status).toBeOneOf([401, 403]);
      expect((await call(token, 'GET', page + own)).status).toBeOneOf([401, 403]);
      expect((await call(token, 'PUT', path, { ...command, expectedVersion: 2 })).status).toBeOneOf([401, 403]);
    }
    expect(await json(await call(first.token, 'GET', path + own))).toMatchObject({ version: 2, completed: true });
  } finally { progress.stopOrderProjection(); await stack.stop(); }
}, 120_000);
