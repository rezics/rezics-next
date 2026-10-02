import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { ContentCore, SaveDraftCommand } from '../../content/src/core.ts';
import { ContentConflict } from '../../content/src/core.ts';
import { saveAdmittedContentDraft } from '../src/modules/content-publication/draft.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('G-957/G-526: Content accepts its character budget in plain and document form before binding exact bytes', async () => {
  const resourceId = native(), author = native();
  const saved: SaveDraftCommand[] = [];
  const env = { fuseki: { query: async () => ({ boolean: true }) },
    lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() } } as unknown as WorkActivationEnvironment;
  const content = { saveDraft: async (command: SaveDraftCommand) => {
    saved.push(command);
    return { outcome: 'succeeded', revisionId: randomUUID(), predecessor: null,
      position: { owner: 'content', dataEpoch: randomUUID(), sequence: '1' }, replayed: false };
  } } as unknown as ContentCore;
  const access = { register: async () => ({ id: randomUUID(), authorityEpoch: '0', state: 'registered',
    replayed: false, scope: `content:draft:${resourceId}` }),
  claim: async () => {}, recordGraphOutcome: async () => {} } as unknown as AccessAdmissionRegistry;
  const base = { resourceId, variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId,
    language: { kind: 'tag' as const, tag: 'zh', originalTag: 'zh' }, direction: 'ltr' as const },
  expectedHead: null, actingSubject: author, idempotencyKey: randomUUID() };
  const body = '字'.repeat(65_536);
  const call = (input: { body: string } | { document: ReturnType<typeof fromPlainText> }) =>
    saveAdmittedContentDraft(env, content, { verify: async () => ({ issuer: 'account', subject: 'writer' }) },
      access, new Request('http://main.local/v1/content-drafts'), { ...base, ...input });
  for (const input of [{ body }, { document: fromPlainText(body) }]) {
    expect(await call(input)).toMatchObject({ outcome: 'succeeded' });
    expect(JSON.parse(saved.at(-1)!.serializedJson).body).toBe(body);
  }
  for (const input of [{ body: body + '字' }, { document: fromPlainText(body + '字') }]) {
    await expect(call(input)).rejects.toBeInstanceOf(ContentConflict);
  }
  expect(saved).toHaveLength(2);
});
