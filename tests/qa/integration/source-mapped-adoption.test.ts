import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { startMediaStack } from './media-support.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

const short = (value: string) => value.slice(-36);

test('a catalogue editor adopts verified Bangumi values through the composed Source owners', async () => {
  const stack = await startMediaStack('mapped-source-adoption');
  try {
    const editor = await stack.member('catalogue-editor');
    await grantRecordedPlatformUse(stack.accessPool, editor.principalId, ['catalogue-import']);
    await editor.grant('work:create:root', 'work.create');
    async function answer<T>(response: Promise<Response>, status = 200): Promise<T> {
      const result = await response, text = await result.text();
      expect(result.status, text).toBe(status);
      return JSON.parse(text) as T;
    }
    const source = { id: 2699, type: 2, name: 'An exact animation title',
      summary: 'A retained synopsis with undetermined reuse rights.', tags: [{ name: 'First' }, { name: 'Second' }] };
    const intake = await answer<{ observation: { observation: string } }>(editor.send('POST', '/v1/sources/intakes', {
      profile: 'source-manual-intake-v1', provider: 'bangumi', namespace: 'subject',
      externalId: String(source.id), sourceRevision: randomUUID(), mediaType: 'application/json',
      retention: 'retained', rawBytesBase64: Buffer.from(JSON.stringify(source)).toString('base64'),
      coverage: { scope: 'bangumi-subject-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: 'Provider evidence is retained; adoption grants no public reuse rights.' },
    }), 201);
    const converted = await answer<{ conversion: { conversion: string } }>(editor.send('POST',
      `/v1/sources/observations/${short(intake.observation.observation)}/conversions`,
      { profile: 'bangumi-subject-map-v1' }), 201);
    expect(converted.conversion.conversion).toMatch(/^https:\/\/rezics.com\/id\//);
  } finally { await stack.stop(); }
}, 120_000);

test('mapped evidence adopts a non-Book Work, ordered children and synopsis without inventing credit or rights', async () => {
  const stack = await startMediaStack('mapped-source-values');
  try {
    const editor = await stack.member('mapped-editor');
    const stranger = await stack.member('mapped-stranger');
    for (const member of [editor, stranger]) {
      await grantRecordedPlatformUse(stack.accessPool, member.principalId, ['catalogue-import']);
    }
    await editor.grant('work:create:root', 'work.create');
    async function answer<T>(response: Promise<Response>, status = 200): Promise<T> {
      const result = await response, text = await result.text();
      expect(result.status, text).toBe(status);
      return JSON.parse(text) as T;
    }
    const raw = { id: 26991, type: 4, name: 'A retained game title', summary: 'An exact retained synopsis.',
      tags: [{ name: 'First' }, { name: 'Second' }, { name: 'First' }] };
    const rightsEvidence = { basis: 'unknown', note: 'Neither authorship nor public reuse rights are established.' };
    type Capture = { record: string; observation: string; sourceRevision: string; rawBytesBase64: string };
    const capture = async (body: typeof raw, revision: string, complete = true) =>
      (await answer<{ observation: Capture }>(editor.send('POST', '/v1/sources/intakes', {
        profile: 'source-manual-intake-v1', provider: 'bangumi', namespace: 'subject',
        externalId: String(body.id), sourceRevision: revision, mediaType: 'application/json', retention: 'retained',
        rawBytesBase64: Buffer.from(JSON.stringify(body)).toString('base64'),
        coverage: { scope: 'bangumi-subject-response-v1', complete, omittedFields: [] }, rightsEvidence,
      }), 201)).observation;
    const convert = (observation: string) => editor.send('POST',
      `/v1/sources/observations/${short(observation)}/conversions`, { profile: 'bangumi-subject-map-v1' });
    const incomplete = await capture(raw, 'incomplete', false);
    expect((await convert(incomplete.observation)).status).toBe(422);
    const propose = async (body: typeof raw, revision: string) => {
      const observation = await capture(body, revision);
      const { conversion } = await answer<{ conversion: { conversion: string; sourceDigest: string;
        projection: { semanticTypes: string[]; children: Array<{ field: string; values: Array<{ sourceKey: string }> }> } } }>(
        convert(observation.observation), 201);
      expect(conversion.projection.semanticTypes).toEqual(['https://schema.org/VideoGame']);
      expect(conversion.projection.children[0]!.values.map(value => value.sourceKey)).toEqual(body.tags.map(tag => tag.name));
      const graphPath = `/v1/sources/conversions/${short(conversion.conversion)}/source-graph`;
      const graph = await answer<{ receipt: string }>(editor.send('POST', graphPath, { profile: 'source-mapped-values-v1' }));
      expect(await answer(editor.send('POST', graphPath, { profile: 'source-mapped-values-v1' }))).toEqual(graph);
      const { proposal } = await answer<{ proposal: { proposal: string; conversion: string;
        observation: string; record: string; candidateTitle: string; semanticTypes: string[];
        rightsEvidence: typeof rightsEvidence } }>(editor.send('POST',
        `/v1/sources/conversions/${short(conversion.conversion)}/proposals/native-work`,
        { profile: 'source-native-work-proposal-v1' }), 201);
      expect(proposal.rightsEvidence).toEqual(rightsEvidence);
      return { observation, conversion, proposal };
    };
    const initial = await propose(raw, 'exact-v1');
    const privateConversion = await stranger.send('POST',
      `/v1/sources/observations/${short(initial.observation.observation)}/conversions`,
      { profile: 'bangumi-subject-map-v1' });
    const absentConversion = await stranger.send('POST',
      `/v1/sources/observations/${randomUUID()}/conversions`, { profile: 'bangumi-subject-map-v1' });
    expect(privateConversion.status).toBe(404);
    expect(absentConversion.status).toBe(404);
    expect(await privateConversion.json()).toEqual(await absentConversion.json());
    expect(initial.observation.rawBytesBase64).toBe(Buffer.from(JSON.stringify(raw)).toString('base64'));
    const conversionPath = `/v1/sources/conversions/${short(initial.conversion.conversion)}`;
    expect((await stranger.send('GET', conversionPath)).status).toBe(404);
    const adoptPath = `/v1/sources/proposals/${short(initial.proposal.proposal)}/adoption/native-work`;
    const adoptBody = { profile: 'source-native-work-adoption-v1', actingSubject: editor.actor,
      confirmedTitle: raw.name, titleLanguage: 'en' };
    const adoptKey = randomUUID();
    const adopted = await answer<{ adoption: { work: string; workRevision: string; semanticTypes: string[];
      rightsStatus: string; title: string }; replayed: boolean }>(editor.send('POST', adoptPath, adoptBody, adoptKey), 201);
    const work = adopted.adoption;
    expect(work).toMatchObject({ semanticTypes: ['https://schema.org/VideoGame'], rightsStatus: 'undetermined', title: raw.name });
    expect(await answer(editor.send('POST', adoptPath, adoptBody, adoptKey))).toEqual({ ...adopted, replayed: true });
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    await editor.grant(`work:read:${work.work}`, 'work.read');
    const workPath = `/v1/works/${short(work.work)}`;
    const header = await answer<{ title: { value: string }; types: string[]; description: unknown }>(editor.read(workPath));
    expect(header.types).toEqual(['https://schema.org/VideoGame']);
    expect(header.description).toBeNull();
    expect((await answer<{ items: unknown[] }>(editor.read(`${workPath}/credits`))).items).toEqual([]);
    const childBody = { profile: 'source-native-child-adoption-v1', field: 'tags',
      proposal: initial.proposal.proposal, conversion: initial.proposal.conversion,
      occurrence: sourceChildOccurrence(initial.proposal.observation, 'tags', 0), sourceOrdinal: 0,
      confirmedSourceKey: 'First', nativeOrdinal: 0, expectedHead: work.workRevision,
      actingSubject: editor.actor, baseSupport: null, correspondence: null, confirmedUse: 'factual-reference-only' };
    const childKey = randomUUID();
    const child = await answer<{ support: { support: string; child: { child: string; revision: string; nativeOrdinal: number } };
      replayed: boolean }>(editor.send('POST', `${workPath}/source-children`, childBody, childKey), 201);
    expect(await answer(editor.send('POST', `${workPath}/source-children`, childBody, childKey))).toEqual({ ...child, replayed: true });
    expect((await editor.send('POST', `${workPath}/source-children`, { ...childBody, sourceOrdinal: 1 })).status).toBe(409);
    const refreshed = await propose({ ...raw, tags: [raw.tags[1]!, raw.tags[0]!, raw.tags[2]!] }, 'exact-v2');
    expect(refreshed.observation.record).toBe(initial.observation.record);
    expect(refreshed.observation.observation).not.toBe(initial.observation.observation);
    const comparisonPath = `${conversionPath}/child-correspondences/${short(refreshed.proposal.conversion)}`;
    const comparison = await answer<{ fields: Array<{ field: string; candidate: Array<{ ordinal: number; status: string }> }> }>(
      editor.send('GET', comparisonPath));
    expect(comparison.fields[0]).toMatchObject({ field: 'tags', candidate: [
      { ordinal: 0, status: 'matched' }, { ordinal: 1, status: 'ambiguous' }, { ordinal: 2, status: 'ambiguous' }] });
    const drift = await answer<{ fields: Array<{ field: string; status: string }> }>(editor.send('GET',
      `${conversionPath}/drift/${short(refreshed.proposal.conversion)}`));
    expect(drift.fields.find(field => field.field === 'tags')?.status).toBe('changed');
    const refreshedChild = { ...childBody, proposal: refreshed.proposal.proposal, conversion: refreshed.proposal.conversion,
      occurrence: sourceChildOccurrence(refreshed.proposal.observation, 'tags', 1), sourceOrdinal: 1,
      baseSupport: child.support.support };
    expect((await editor.send('POST', `${workPath}/source-children`, refreshedChild)).status).toBe(409);
    const decision = await answer<{ correspondence: { correspondence: string } }>(editor.send('POST', '/v1/sources/correspondences', {
      profile: 'source-child-correspondence-v1', baseConversion: short(initial.proposal.conversion),
      candidateConversion: short(refreshed.proposal.conversion), field: 'tags', baseOccurrence: childBody.occurrence,
      candidateOccurrence: refreshedChild.occurrence, confirmedSameSourceChild: true,
    }), 201);
    const renewed = await answer<typeof child>(editor.send('POST', `${workPath}/source-children`,
      { ...refreshedChild, correspondence: decision.correspondence.correspondence }), 201);
    expect(renewed.support.child).toEqual(child.support.child);
    const controlPath = `${workPath}/fields/synopsis/control`;
    type Control = { workHead: string; contentHead: string | null; controlHead: string | null;
      controlEpoch: string; mode: string; value: string | null; rightsStatus: string | null };
    const before = await answer<Control>(editor.read(controlPath));
    const fieldBody = { profile: 'work-editorial-field-control-v1', field: 'synopsis', expectedWorkHead: work.workRevision,
      basis: { contentHead: before.contentHead, head: before.controlHead, epoch: before.controlEpoch, protection: null },
      value: raw.summary, origin: 'source', actingSubject: editor.actor,
      source: { record: initial.proposal.record, observation: initial.proposal.observation,
        conversion: initial.proposal.conversion, mapping: 'bangumi-subject-map-v1' } };
    expect((await editor.send('POST', controlPath, { ...fieldBody, value: 'Unverified text' })).status).toBe(409);
    const fieldKey = randomUUID();
    const applied = await answer<{ support: string; content: string; replayed: boolean }>(editor.send('POST', controlPath, fieldBody, fieldKey), 201);
    expect(await answer(editor.send('POST', controlPath, fieldBody, fieldKey))).toEqual({ ...applied, replayed: true });
    const after = await answer<Control>(editor.read(controlPath));
    expect(after).toMatchObject({ value: raw.summary, mode: 'source-managed', rightsStatus: 'undetermined', contentHead: applied.content });
    const supportPath = `/v1/sources/field-supports/${short(applied.support)}`;
    const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 64, bytesLeft: 262_144 };
    const support = await fusekiReadBudget.run(budget, () => answer<{ supportIdentity: string; state: string;
      nativeRevision: string; mappingRevision: string }>(editor.send('GET', supportPath)));
    expect(64 - budget.callsLeft).toBeLessThanOrEqual(32);
    expect(262_144 - budget.bytesLeft).toBeLessThan(128_000);
    expect(support).toMatchObject({ state: 'recorded', nativeRevision: applied.content });
    expect((await stranger.send('GET', supportPath)).status).toBe(404);
    const withdrawalBody = { profile: 'source-field-withdrawal-v1', support: applied.support,
      expectedSupport: support.supportIdentity, reason: 'Withdraw the evidence without deleting native content' };
    const withdrawalKey = randomUUID();
    await answer(editor.send('POST', '/v1/sources/withdrawals', withdrawalBody, withdrawalKey), 201);
    await answer(editor.send('POST', '/v1/sources/withdrawals', withdrawalBody, withdrawalKey));
    expect((await answer<{ state: string }>(editor.send('GET', supportPath))).state).toBe('withdrawn');
    expect(await answer(editor.read(controlPath))).toEqual(after);
    await answer(editor.send('POST', '/v1/sources/withdrawals', {
      profile: 'source-support-withdrawal-v1', support: child.support.support,
      expectedSupport: child.support.support, reason: 'Withdraw an occurrence witness',
    }), 201);
    expect((await answer<{ state: string }>(editor.send('GET',
      `/v1/sources/native-child-supports/${short(child.support.support)}`))).state).toBe('withdrawn');
    expect((await answer<{ items: unknown[] }>(editor.read(`${workPath}/credits`))).items).toEqual([]);
  } finally { await stack.stop(); }
}, 120_000);
