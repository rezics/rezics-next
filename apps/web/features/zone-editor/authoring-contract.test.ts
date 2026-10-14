import { expect, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import { commandLane } from '../api/command.ts';
import { browserZoneAuthoring, browserZoneRealmAttachment, commitCommand, loadCompleteZoneNavigation, zoneCommandLane,
  type PublishedSite, type SavedDraft, type WriteResult } from './api.ts';
import { readZoneAuthoring, readZoneManagementFrame } from './authoring-reads.ts';
import { authoringContractClient, contractActor, contractManagementKey, contractStateHead, contractCompetingHead, contractBasis, contractDocument, contractHead, contractHome, contractSavingAgent,
  contractZoneId, type AuthoringContractState } from './authoring-contract.fixtures.ts';
import { publicationChoice, publicationStatus, reduceEditor, reopenEditorDraft } from './model.ts';
import { loadSavedPreviewFrame } from './saved-preview-frame.ts';

for (const state of ['retired', 'recovered', 'restored', 'operator-mandate'] as const) {
  test(`${state} reopens the same exact saved Agent cut through the production readers`, async () => {
    const fixture = authoringContractClient(state);
    const frame = await readZoneManagementFrame(fixture.main, contractManagementKey(state), 'en', contractActor(state));
    expect(frame.lifecycleOnly).toBe(state === 'retired');
    expect(frame.lifecycle).toMatchObject({ kind: 'ready', revision: contractStateHead(state), status: state === 'retired' ? 'retired' : 'active' });
    expect(frame.authoring.kind).toBe('ready');
    if (frame.authoring.kind !== 'ready') throw new Error('Saved cut unavailable');
    expect(frame.authoring.model.state.basis).toEqual(contractBasis);
    expect(frame.authoring.model.state.value).toBe(serializeDocument(contractDocument));
    expect(frame.authoring.model.state.language).toEqual({ kind: 'tag', tag: 'ja', originalTag: 'ja' });
    expect(fixture.manifest.saved.provenance.author).toBe(contractSavingAgent);
    expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
    if (state === 'retired') expect(fixture.calls.some(call => call.path.includes('addresses/resolve'))).toBe(false);
    const loaded = await loadSavedPreviewFrame({
      authoring: async () => frame.authoring,
      navigation: saved => loadCompleteZoneNavigation(fixture.main, contractZoneId, contractActor(state), saved.model.state),
      presentation: async () => ({ ok: false }), realmHeader: async () => ({ ok: false }), installedDigest: async () => null,
      packages: { load: async () => { throw new Error('No approved package'); }, declarations: async () => null },
    }, { locale: 'en', homeName: 'Home', lookEnabled: true });
    expect(loaded.kind).toBe('ready');
    if (loaded.kind === 'ready') expect(loaded.frame.saved.model.document).toEqual(contractDocument);
  });
}

for (const state of ['revoked-member', 'revoked-moderator', 'operator-without-agent'] as const) {
  test(`${state} cannot open the editor or preview from public admission or remembered draft identity`, async () => {
    const fixture = authoringContractClient(state);
    const frame = await readZoneManagementFrame(fixture.main, contractManagementKey(state), 'en', contractActor(state));
    expect(frame.authoring).toEqual({ kind: 'failure', failure: 'denied' });
    expect(frame.lifecycle).toEqual({ kind: 'failure', failure: 'denied' });
    expect(frame.draftZoneId).toBeNull();
    const api = browserZoneAuthoring(fixture.main);
    const publish = fixture.manifest.writes[1]!.body;
    const saved = fixture.manifest.saved.page;
    expect(await api.publish({ ...saved, zoneHead: contractHead, routesRevision: publish.routesRevision,
      navigationRevision: publish.navigationRevision }, contractActor(state), 'known-owner-key', contractZoneId))
      .toMatchObject({ ok: false, failure: 'denied' });
    expect(await api.saveDraft(fixture.manifest.writes[0]!.body, 'known-save-key')).toMatchObject({ ok: false, failure: 'denied' });
    expect(fixture.manifest.saved.document).toEqual(contractDocument);
    expect(fixture.manifest.saved.provenance.author).toBe(contractSavingAgent);
  });
}

test('HTTP 202 retains the exact publication and stable retry key without reporting an unavailable service', async () => {
  const fixture = authoringContractClient('pending-publication');
  const api = browserZoneAuthoring(fixture.main);
  const loaded = await readZoneAuthoring(fixture.main, contractZoneId, 'en', contractActor('pending-publication'));
  if (loaded.kind !== 'ready') throw new Error('Missing saved cut');
  const choice = publicationChoice(loaded.model.state)!;
  const lane = commandLane<typeof choice, WriteResult<PublishedSite>>({ ok: false, failure: 'unavailable' });
  const write = (_choice: typeof choice, round: Parameters<typeof commitCommand>[0]) =>
    commitCommand(round, key => api.publish(_choice, contractActor('pending-publication'), key, contractZoneId));
  expect(await lane.submit(choice, write)).toEqual({ ok: false, failure: 'pending' });
  expect(fixture.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  const replay = await lane.submit(choice, write);
  expect(replay).toMatchObject({ ok: true, data: { replayed: true, receipt: fixture.receipt } });
  const writes = fixture.calls.filter(call => call.method === 'POST');
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]!.body).toEqual(fixture.manifest.writes[1]!.body);
});

test('a replayed receipt remains original after refreshing the current competing cut, without replacing saved bytes', async () => {
  const fixture = authoringContractClient('replayed-after-competition');
  const api = browserZoneAuthoring(fixture.main);
  const opened = await readZoneAuthoring(fixture.main, contractZoneId, 'en', contractActor('replayed-after-competition'));
  if (opened.kind !== 'ready') throw new Error('Missing current cut');
  const choice = publicationChoice(opened.model.state)!;
  const answer = await commitCommand({ key: 'original-receipt-key', seq: 1, superseded: () => false, confirm: () => {}, afterConfirmed: false },
    key => api.publish(choice, contractActor('replayed-after-competition'), key, contractZoneId));
  const current = await api.readDraft(contractZoneId, contractActor('replayed-after-competition'));
  if (!current.ok) throw new Error('Current competing cut unavailable');
  const writes = fixture.calls.filter(call => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  if (!answer.ok) throw new Error('Missing receipt');
  const acknowledged = reduceEditor(opened.model.state, { type: 'published', ...answer.data, revisionId: choice.revisionId });
  expect(publicationStatus(acknowledged)).toBe('unknown');
  const refreshed = reduceEditor(acknowledged, { type: 'publication-current', ...current.data });
  expect(publicationStatus(refreshed)).toBe('behind');
  expect(refreshed.publishedReceipt).toEqual(fixture.receipt);
  expect(refreshed.zoneHead).toBe(contractCompetingHead);
  expect(refreshed.value).toBe(opened.model.state.value);
  expect(refreshed.basis).toEqual(contractBasis);
});

for (const state of ['empty', 'unavailable'] satisfies AuthoringContractState[]) {
  test(`${state} follows the production page boundary`, async () => {
    const fixture = authoringContractClient(state);
    const loaded = await readZoneAuthoring(fixture.main, contractZoneId, 'en', contractActor(state));
    if (state === 'empty') {
      expect(loaded.kind).toBe('ready');
      if (loaded.kind === 'ready') expect(loaded.model.state.basis).toBeNull();
    } else expect(loaded).toEqual({ kind: 'failure', failure: 'unavailable' });
  });
}

test('fresh restored authority clears a remembered refusal while retaining unsaved bytes and the original stale-check basis', async () => {
  const fixture = authoringContractClient('restored');
  const loaded = await readZoneAuthoring(fixture.main, contractZoneId, 'en', contractActor('restored'));
  if (loaded.kind !== 'ready') throw new Error('Restored editor unavailable');
  const local = reduceEditor(reduceEditor(loaded.model.state, { type: 'edit', value: 'My retained unsaved text' }),
    { type: 'failed', failure: 'denied' });
  const reopened = reopenEditorDraft(local, loaded.model.state);
  expect(reopened.notice).toEqual({ kind: 'idle' });
  expect(reopened.value).toBe('My retained unsaved text');
  expect(reopened.basis).toEqual(contractBasis);
  expect(reopened.expectedHead).toBe(contractBasis.revisionId);
  expect(reopenEditorDraft(local, { ...loaded.model.state, homeDocument: contractSavingAgent })).toBe(local);
});

test('an operation-shaped HTTP 200 is unavailable, and only HTTP 202 is pending', async () => {
  for (const status of [200, 202]) {
    const main = { v1: { 'content-drafts': { post: async () => ({
      data: { operationId: 'shape-alone-cannot-admit', status: 'reconciling' }, error: null, response: { status },
    }) } } };
    const body = authoringContractClient('saved').manifest.writes[0].body;
    expect(await browserZoneAuthoring(main as never).saveDraft(body, 'same-envelope'))
      .toEqual({ ok: false, failure: status === 202 ? 'pending' : 'unavailable' });
  }
});

test('an accepted save checks the same envelope and key and reopens its newly acknowledged revision and epoch', async () => {
  const fixture = authoringContractClient('pending-save');
  const api = browserZoneAuthoring(fixture.main);
  const body = fixture.manifest.writes[0].body;
  const lane = zoneCommandLane<typeof body, WriteResult<SavedDraft>>({ ok: false, failure: 'unavailable' });
  const write = (choice: typeof body, round: Parameters<typeof commitCommand>[0]) => commitCommand(round, key => api.saveDraft(choice, key));
  expect(await lane.submit(body, write)).toEqual({ ok: false, failure: 'pending' });
  const saved = await lane.submit(body, write);
  expect(saved.ok).toBe(true);
  const writes = fixture.calls.filter(call => call.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]!.body).toEqual(body);
  const reopened = await api.readDraft(contractZoneId, fixture.manifest.actingSubject);
  if (!saved.ok || !reopened.ok) throw new Error('Acknowledged draft unavailable');
  expect(reopened.data.basis).toEqual({ revisionId: saved.data.revisionId, byteDigest: saved.data.byteDigest, contentEpoch: saved.data.contentEpoch });
  expect(reopened.data.document).toEqual(body.document);
  expect(reopened.data.basis).not.toEqual(contractBasis);
});

test('an accepted envelope survives temporary revocation and replays the same key after restoration', async () => {
  const lane = zoneCommandLane<{ expectedHead: string }, WriteResult<string>>({ ok: false, failure: 'unavailable' });
  const choice = { expectedHead: contractHead };
  const keys: string[] = [];
  const rounds: WriteResult<string>[] = [{ ok: false, failure: 'pending' }, { ok: false, failure: 'denied' }, { ok: true, data: 'original-receipt' }];
  for (let i = 0; i < 3; i++) {
    const answer = await lane.submit(choice, async (_chosen, round) => { keys.push(round.key); return rounds[i]!; });
    expect(lane.needsConfirmation(answer)).toBe(i < 2);
  }
  expect(new Set(keys).size).toBe(1);
});

test('attachment uses the addressed Realm capability across Spaces and never invents it from a Zone', async () => {
  const actor = contractSavingAgent;
  const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000001124';
  for (const hasRealm of [false, true]) {
    const queries: unknown[] = [];
    const main = { v1: {
      addresses: { resolve: { get: async (query: unknown) => { queries.push(query); return { data: { status: 'resolved',
        holder: contractSavingAgent, capabilities: { zone: contractHome, ...(hasRealm ? { realm } : {}) } }, error: null }; } } },
      realms: ({ realm: id }: { realm: string }) => { expect(id).toBe(realm.slice(-36));
        return { get: async () => ({ data: { name: { value: 'Cross-Space Realm' } }, error: null }) }; },
    } };
    const answer = await browserZoneRealmAttachment(main as never).resolveRealmHandle('community-space', actor);
    expect(answer).toEqual(hasRealm ? { ok: true, data: { realm, name: 'Cross-Space Realm' } } : { ok: false, failure: 'denied' });
    expect(queries).toEqual([{ query: { scope: 'space', key: 'community-space', actingSubject: actor } }]);
  }
});
