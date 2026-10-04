import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import type { ReleaseView } from '../../../services/main/src/modules/release/read.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';
import type { ReleaseV2Write, ReleaseWrite } from '../../../services/main/src/modules/release/schema.ts';
import { readReleaseReceipt } from '../../../services/main/src/modules/release/command.ts';
import { readRealizationReceipt } from '../../../services/main/src/modules/realization/command.ts';
import { ownerOutboxEventHandler } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { assertCommandRace } from '../support/command-race.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const root = (work: string) => `/v1/works/${work.slice(-36)}`;
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
type Editor = Awaited<ReturnType<MediaStack['member']>>;
type WriteResult = { revision: string; receipt: string; replayed: boolean; sourcePosition: { dataEpoch: string; sequence: string } };

function text(editor: Editor, work: string, language: string,
  overrides: Partial<RealizationWrite> = {}): RealizationWrite {
  return { profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor, id: id(),
    language, kind: 'translation', translators: [editor.actor], publishers: [editor.actor],
    source: { kind: 'unresolved', work }, status: 'official', verification: 'verified', evidence: id(), ...overrides };
}
function release(editor: Editor, coverage: ReleaseV2Write['coverage'], overrides: Partial<ReleaseV2Write> = {}): ReleaseV2Write {
  return { profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: id(), kind: 'formal',
    status: 'official', title: { value: 'Sword Art Online', language: 'en' }, titleLanguage: 'en', tracklistLanguage: null,
    editionStatement: null, publisher: 'Yen Press', publicationYear: 2014, isbn13: null,
    originalUrl: null, fixedRelease: null, evidence: null, identifiers: [], platform: 'paperback', territory: 'US', coverage,
    ...overrides };
}
const saveText = (editor: Editor, work: string, body: RealizationWrite, key?: string) =>
  editor.send('PUT', `${root(work)}/realizations/${body.id.slice(-36)}`, body, key);
const saveRelease = (editor: Editor, work: string, body: ReleaseV2Write, key?: string) =>
  editor.send('PUT', `${root(work)}/releases/${body.id.slice(-36)}`, body, key);
const covered = (body: RealizationWrite, result: WriteResult) =>
  ({ realization: body.id, revision: result.revision, completeness: 'complete' as const });

test('G833: SAO translations share Works, exact releases cover several volumes and identifiers resolve every grain', async () => {
  const stack = await startMediaStack('g833-catalogue');
  try {
    const editor = await stack.member('catalogue');
    const publishers = { yenPress: id(), taiwanKadokawa: id(), hunanFineArts: id() };
    const volumes = [];
    const english = [];
    for (let volume = 1; volume <= 3; volume++) {
      const work = await stack.publicWork(editor.actor, ['ja'], `Sword Art Online volume ${volume}`);
      await editor.grant(`work:edit:${work.work}`, 'work.edit');
      volumes.push(work);
      const body = text(editor, work.work, 'en', { publishers: [publishers.yenPress] });
      const result = await json<WriteResult>(await saveText(editor, work.work, body));
      english.push({ body, result });
    }
    const work = volumes[0]!;
    const en = english[0]!;
    const hans = text(editor, work.work, 'zh-Hans', { publishers: [publishers.hunanFineArts] });
    const hant = text(editor, work.work, 'zh-Hant', { publishers: [publishers.taiwanKadokawa] });
    await json(await saveText(editor, work.work, hans));
    await json(await saveText(editor, work.work, hant));
    const texts = await json<{ items: { id: string; work: string; language: string }[] }>(
      await stack.call('GET', `${root(work.work)}/realizations`));
    expect(new Set(texts.items.map(item => item.work))).toEqual(new Set([work.work]));
    expect(new Set(texts.items.map(item => item.language))).toEqual(new Set(['en', 'zh-Hans', 'zh-Hant']));
    expect(new Set(texts.items.map(item => item.id)).size).toBe(3);
    expect(await json(await stack.call('GET', `${root(work.work)}/realizations/${hant.id.slice(-36)}`)))
      .toMatchObject({ language: 'zh-Hant', publishers: [publishers.taiwanKadokawa] });
    expect(await json(await stack.call('GET', `${root(work.work)}/realizations/${hans.id.slice(-36)}`)))
      .toMatchObject({ language: 'zh-Hans', publishers: [publishers.hunanFineArts] });

    // Publisher evidence for the paperback ISBN:
    // https://yenpress.com/titles/9780316371247-sword-art-online-1-aincrad-light-novel
    // Digital identifiers and omnibus below are synthetic identity/coverage controls.
    const paperback = release(editor, [covered(en.body, en.result)], { isbn13: '9780316371247' });
    const saved = await json<WriteResult>(await saveRelease(editor, work.work, paperback));
    const digital = release(editor, [covered(en.body, en.result)], { platform: 'ebook',
      identifiers: [{ provider: 'https://store.example', value: 'sao-volume-1' }] });
    await json(await saveRelease(editor, work.work, digital));
    const omnibus = release(editor, english.map(entry => covered(entry.body, entry.result)),
      { title: { value: 'Volumes 1–3 omnibus', language: 'en' } });
    const omnibusSaved = await json<WriteResult>(await saveRelease(editor, work.work, omnibus));
    const admission = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { <${omnibusSaved.receipt}> rv:admissionId ?admission } } LIMIT 2`))
      .results!.bindings[0]!.admission!.value;
    const terminal = (await readReleaseReceipt(stack.env, admission))!;
    const handler = ownerOutboxEventHandler(`${RV}ReleaseChangedEvent`)!;
    const eventValues = { admissionId: admission, receipt: terminal.receipt, digest: terminal.requestDigest,
      scope: terminal.scope, authorityEpoch: terminal.authorityEpoch };
    const cloud = await handler.read({ fuseki: stack.fuseki, eventId: `urn:event:${randomUUID()}`, ordinal: 0,
      batch: { batchId: 'urn:batch:g833', dataEpoch: terminal.dataEpoch, routingEpoch: stack.env.lineage.routingEpoch,
        sequence: terminal.sequence } as Parameters<typeof handler.read>[0]['batch'],
      value: name => eventValues[name as keyof typeof eventValues] });
    expect(cloud.data.receipt.works).toEqual(expect.arrayContaining(volumes.map(item => item.work)));
    expect(cloud.data.receipt.coverage).toHaveLength(3);
    for (const volume of volumes) {
      const page = await json<{ items: ReleaseView[] }>(await stack.call('GET', `${root(volume.work)}/releases`));
      expect(page.items.map(item => item.id)).toContain(omnibus.id);
      const omnibusView = page.items.find(item => item.id === omnibus.id)!;
      expect(omnibusView.coverage.map(item => item.work)).toEqual(expect.arrayContaining(volumes.map(item => item.work)));
      expect(omnibusView.coverage.map(item => item.mainVersion)).toEqual(expect.arrayContaining(volumes.map(item => item.mainVersion)));
      expect(await json(await stack.call('GET', `${root(volume.work)}/releases/${omnibus.id.slice(-36)}`)))
        .toMatchObject({ id: omnibus.id, revision: omnibusSaved.revision });
    }
    const found = await json<{ items: ReleaseView[] }>(await stack.call('GET', '/v1/releases?isbn13=9780316371247'));
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ id: paperback.id, revision: saved.revision, profile: 'release-v2', isbn13: paperback.isbn13,
      coverage: [{ realization: en.body.id, revision: en.result.revision, work: work.work,
        mainVersion: work.mainVersion, language: 'en', completeness: 'complete' }] });
    const store = await json<{ items: ReleaseView[] }>(await stack.call('GET',
      '/v1/releases?provider=https%3A%2F%2Fstore.example&identifier=sao-volume-1'));
    expect(store.items.map(item => item.id)).toEqual([digital.id]);
    expect((await json<{ items: unknown[] }>(await stack.call('GET',
      '/v1/releases?provider=https%3A%2F%2Fanother.example&identifier=sao-volume-1'))).items).toEqual([]);
    for (const query of ['', '?isbn13=9780316371248', '?provider=https%3A%2F%2Fstore.example',
      '?isbn13=9780316371247&provider=https%3A%2F%2Fstore.example&identifier=sao-volume-1']) {
      expect((await stack.call('GET', `/v1/releases${query}`)).status).toBe(400);
    }
    const projected = await stack.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(paperback.id)} rv:coverage ?entry ; rv:platform "paperback" ;
        rv:territory "US" ; rv:isbn13 "9780316371247" .
        ?entry rv:work ${iri(work.work)} ; rv:realization ${iri(en.body.id)} ; rv:revision ${iri(en.result.revision)} ;
          rv:contentLanguage "en" ; rv:completeness "complete" }
    }`);
    expect(projected.boolean).toBe(true);

    const later = release(editor, [{ ...covered(hant, { revision: id() } as WriteResult) }]);
    expect((await saveRelease(editor, work.work, later)).status).toBe(400);
    const malformed = { ...paperback, id: id(), coverage: [{ work: work.work, completeness: 'complete' }] };
    expect((await editor.send('PUT', `${root(work.work)}/releases/${malformed.id.slice(-36)}`, malformed)).status).toBe(400);

    const webWork = await stack.publicWork(editor.actor, ['ja'], 'SAO web Work');
    await editor.grant(`work:edit:${webWork.work}`, 'work.edit');
    const fan = text(editor, webWork.work, 'en', { status: 'unofficial', verification: 'unverified', evidence: null });
    const fanResult = await json<WriteResult>(await saveText(editor, webWork.work, fan));
    expect(await json(await stack.call('GET', `${root(webWork.work)}/realizations/${fan.id.slice(-36)}`)))
      .toMatchObject({ status: 'unofficial', verification: 'unverified', work: webWork.work,
        source: { kind: 'unresolved', work: webWork.work } });
    expect((await saveRelease(editor, webWork.work, release(editor, [covered(fan, fanResult)]))).status).toBe(400);
  } finally { await stack.stop(); }
}, 120_000);

test('G833: CAS, denied writes, concurrent corrections, exact sources and lost-response replays retain one outcome', async () => {
  const stack = await startMediaStack('g833-cas');
  try {
    const editor = await stack.member('editor'), stranger = await stack.member('stranger');
    const work = await stack.publicWork(editor.actor, ['ja'], 'Exact-source Work');
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const main = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work.mainVersion)} rv:head ?head } } LIMIT 2`)).results!.bindings[0]!.head!.value;
    const body = text(editor, work.work, 'en', { source: { kind: 'main-version', work: work.work,
      mainVersion: work.mainVersion, revision: main } });
    expect((await saveText(stranger, work.work, { ...body, actingSubject: stranger.actor })).status).toBe(403);
    const sourceMissing = text(editor, work.work, 'en', { source: { kind: 'main-version', work: work.work,
      mainVersion: work.mainVersion, revision: id() } });
    expect((await saveText(editor, work.work, sourceMissing)).status).toBe(503);
    const first = await json<WriteResult>(await saveText(editor, work.work, body));
    const another = text(editor, work.work, 'zh-Hant', { source: { kind: 'realization', work: work.work,
      realization: body.id, revision: first.revision } });
    const other = await json<WriteResult>(await saveText(editor, work.work, another));
    const invalidTextKey = `invalid-text-${randomUUID()}`;
    const invalidText = { ...body, expectedHead: first.revision, language: 'zh-Hans', evidence: id() };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await saveText(editor, work.work, invalidText, invalidTextKey)).status).toBe(400);
    }
    expect((await stack.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1',
      [invalidTextKey])).rowCount).toBe(0);
    const pub = release(editor, [covered(body, first)]);
    expect((await saveRelease(stranger, work.work, { ...pub, actingSubject: stranger.actor,
      coverage: [{ realization: id(), revision: id(), completeness: 'unknown' }] })).status).toBe(403);
    const pubResult = await json<WriteResult>(await saveRelease(editor, work.work, pub));
    const invalidReleaseKey = `invalid-release-${randomUUID()}`;
    const invalidRelease = { ...pub, expectedHead: pubResult.revision, evidence: id(),
      coverage: [...pub.coverage, covered(another, other)] };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await saveRelease(editor, work.work, invalidRelease, invalidReleaseKey)).status).toBe(400);
    }
    expect((await stack.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1',
      [invalidReleaseKey])).rowCount).toBe(0);

    const correction = { ...body, expectedHead: first.revision, publishers: [id()], evidence: id() };
    const key = `lost-response-${randomUUID()}`;
    const originalCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    let dropped = false;
    const outcomes: unknown[] = [];
    stack.fuseki.commandWithReceipt = async options => {
      const result = await originalCommand(options);
      outcomes.push(result);
      if (!dropped && result.status === 'committed' && options.update.includes('RealizationChangedEvent')) {
        dropped = true;
        throw new Error('Simulated response loss after durable graph commit');
      }
      return result;
    };
    const correctionResponse = await saveText(editor, work.work, correction, key);
    if (correctionResponse.status !== 200) {
      throw new Error(`Correction ${correctionResponse.status}: ${await correctionResponse.text()}; commands ${JSON.stringify(outcomes)}`);
    }
    const corrected = await json<WriteResult>(correctionResponse);
    stack.fuseki.commandWithReceipt = originalCommand;
    expect(dropped).toBe(true);
    const replay = await json<WriteResult>(await saveText(editor, work.work, correction, key));
    expect(replay).toMatchObject({ revision: corrected.revision, receipt: corrected.receipt, replayed: true });
    expect((await saveText(editor, work.work, correction)).status).toBe(409);
    expect((await saveText(editor, work.work, { ...correction, publishers: [id()] }, key)).status).toBe(409);
    await json(await saveText(editor, work.work,
      { ...correction, expectedHead: corrected.revision, publishers: [id()], evidence: id() }));
    expect(await json(await saveText(editor, work.work, correction, key)))
      .toMatchObject({ revision: corrected.revision, receipt: corrected.receipt, replayed: true });
    const exact = await json<{ source: object }>(await stack.call('GET', `${root(work.work)}/realizations/${another.id.slice(-36)}`));
    expect(exact.source).toEqual({ kind: 'realization', work: work.work, realization: body.id, revision: first.revision });
    expect(await json(await stack.call('GET', `${root(work.work)}/realizations/${body.id.slice(-36)}?revision=${encodeURIComponent(first.revision)}`)))
      .toMatchObject({ revision: first.revision, publishers: body.publishers });
    const currentRelease = await json<ReleaseView>(await stack.call('GET', `${root(work.work)}/releases/${pub.id.slice(-36)}`));
    expect(currentRelease.coverage[0]!.revision).toBe(first.revision);

    const pubKey = `correction-${randomUUID()}`;
    const correctedPub = { ...pub, expectedHead: pubResult.revision, evidence: id(), publisher: 'Evidence correction' };
    const pubCorrected = await json<WriteResult>(await saveRelease(editor, work.work, correctedPub, pubKey));
    expect(await json(await saveRelease(editor, work.work, correctedPub, pubKey)))
      .toMatchObject({ revision: pubCorrected.revision, receipt: pubCorrected.receipt, replayed: true });
    const racingCommands = [1, 2].map((value) =>
      saveRelease.bind(
        null,
        editor,
        work.work,
        {
          ...correctedPub,
          expectedHead: pubCorrected.revision,
          evidence: id(),
          publisher: `Racing ${value}`,
        },
        randomUUID(),
      ),
    );
    await assertCommandRace(await Promise.all(racingCommands.map((send) => send())), 200, (index) =>
      racingCommands[index]!(),
    );
    expect(await json(await saveRelease(editor, work.work, correctedPub, pubKey)))
      .toMatchObject({ revision: pubCorrected.revision, receipt: pubCorrected.receipt, replayed: true });

    const event = ownerOutboxEventHandler(`${RV}RealizationChangedEvent`)!;
    const receiptRows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { <${corrected.receipt}> rv:admissionId ?admission } } LIMIT 2`)).results!.bindings;
    const admissionId = receiptRows[0]!.admission!.value;
    const terminal = (await readRealizationReceipt(stack.env, admissionId))!;
    const values = { admissionId, receipt: terminal.receipt, digest: terminal.requestDigest,
      scope: terminal.scope, authorityEpoch: terminal.authorityEpoch };
    const cloud = await event.read({ fuseki: stack.fuseki, eventId: `urn:event:${randomUUID()}`,
      batch: { batchId: 'urn:batch:g833', dataEpoch: terminal.dataEpoch, routingEpoch: stack.env.lineage.routingEpoch,
        sequence: terminal.sequence } as Parameters<typeof event.read>[0]['batch'], ordinal: 0,
      value: name => values[name as keyof typeof values] });
    expect(cloud.data.receipt).toMatchObject({ realization: body.id, revision: corrected.revision });
    await expect(readReleaseReceipt(stack.env, admissionId)).rejects.toThrow('Release receipt is incomplete');
  } finally { await stack.stop(); }
}, 120_000);

test('G833: attaching a release requires edit authority on every covered Work before admission', async () => {
  const stack = await startMediaStack('g833-covered-authority');
  try {
    const owner = await stack.member('owner'), editor = await stack.member('editing-only');
    const other = await stack.publicWork(owner.actor, ['ja'], 'Another editor owns this Work');
    const own = await stack.publicWork(editor.actor, ['ja'], 'The editing Work');
    await owner.grant(`work:edit:${other.work}`, 'work.edit');
    await editor.grant(`work:edit:${own.work}`, 'work.edit');
    const otherText = text(owner, other.work, 'en'), ownText = text(editor, own.work, 'en');
    const otherSaved = await json<WriteResult>(await saveText(owner, other.work, otherText));
    const ownSaved = await json<WriteResult>(await saveText(editor, own.work, ownText));
    const body = release(editor, [covered(ownText, ownSaved), covered(otherText, otherSaved)],
      { isbn13: '9780316371247' });
    const key = `covered-denied-${randomUUID()}`;
    const before = await json(await stack.call('GET', `${root(other.work)}/releases`));
    const isbnBefore = (await json<{ items: ReleaseView[] }>(await stack.call('GET', '/v1/releases?isbn13=9780316371247')))
      .items.map(item => item.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await saveRelease(editor, own.work, body, key)).status).toBe(403);
    }
    expect(await json(await stack.call('GET', `${root(other.work)}/releases`))).toEqual(before);
    const isbnAfter = (await json<{ items: ReleaseView[] }>(await stack.call('GET', '/v1/releases?isbn13=9780316371247')))
      .items.map(item => item.id);
    expect(isbnAfter).toEqual(isbnBefore);
    expect(isbnAfter).not.toContain(body.id);
    expect((await stack.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1', [key])).rowCount).toBe(0);
    expect((await stack.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} { ${iri(body.id)} ?p ?o } }`)).boolean).toBe(false);

    await editor.grant(`work:edit:${other.work}`, 'work.edit');
    await json(await saveRelease(editor, own.work, body, key));
    expect((await json<{ items: ReleaseView[] }>(await stack.call('GET', `${root(other.work)}/releases`)))
      .items.map(item => item.id)).toContain(body.id);
    // A revoked covered-Work grant also refuses a correction, before it obtains an admission.
    await stack.accessPool.query('UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1 AND scope_id = $2',
      [editor.actor, `work:edit:${other.work}`]);
    const current = await json<ReleaseView>(await stack.call('GET', `${root(own.work)}/releases/${body.id.slice(-36)}`));
    expect((await saveRelease(editor, own.work, { ...body, expectedHead: current.revision,
      evidence: id(), publisher: 'Changed publisher' })).status).toBe(403);
  } finally { await stack.stop(); }
}, 120_000);

test('G833: full 64-realization coverage stays bounded and a large release can be corrected and replayed', async () => {
  const stack = await startMediaStack('g833-bounds');
  try {
    const editor = await stack.member('bounded');
    const work = await stack.publicWork(editor.actor, ['ja'], 'Many independently identified texts');
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const coverage: ReleaseV2Write['coverage'] = [];
    for (let index = 0; index < 64; index++) {
      const body = text(editor, work.work, 'ja', { kind: 'original', translators: [] });
      const saved = await json<WriteResult>(await saveText(editor, work.work, body));
      coverage.push({ ...covered(body, saved), completeness: index % 2 ? 'partial' : 'complete', portion: `part ${index + 1}` });
    }
    const body = release(editor, coverage);
    const saved = await json<WriteResult>(await saveRelease(editor, work.work, body));
    const page = await json<{ items: ReleaseView[] }>(await stack.call('GET', `${root(work.work)}/releases`));
    expect(page.items.find(item => item.id === body.id)!.coverage).toHaveLength(64);
    const correction = { ...body, expectedHead: saved.revision, evidence: id(), publicationYear: 2015 };
    const key = `large-${randomUUID()}`;
    const corrected = await json<WriteResult>(await saveRelease(editor, work.work, correction, key));
    expect(await json(await saveRelease(editor, work.work, correction, key)))
      .toMatchObject({ revision: corrected.revision, receipt: corrected.receipt, replayed: true });
    const ids = [];
    let cursor: string | null = null;
    do {
      const result = await json<{ items: { id: string }[]; nextCursor: string | null }>(await stack.call('GET',
        `${root(work.work)}/realizations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
      ids.push(...result.items.map(item => item.id));
      cursor = result.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(64);
    expect(new Set(ids).size).toBe(64);
  } finally { await stack.stop(); }
}, 120_000);

test('G833: v1 reads as unknown realization coverage; legacy translations retain every installed record and disclosure', async () => {
  const stack = await startMediaStack('g833-legacy');
  try {
    const editor = await stack.member('legacy');
    const work = await stack.publicWork(editor.actor, ['ja'], 'Legacy source');
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const target = await stack.publicWork(editor.actor, ['zh-Hant'], 'Legacy translation');
    const mainRevision = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(target.mainVersion)} rv:head ?head } } LIMIT 2`)).results!.bindings[0]!.head!.value;
    const linked = { link: id() };
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(linked.link)} a rv:TranslationLink ;
        rv:targetWork ${iri(target.work)} ; rv:targetMainVersion ${iri(target.mainVersion)} ;
        rv:targetMainRevision ${iri(mainRevision)} ; rv:sourceWork ${iri(work.work)} ;
        rv:sourceMainVersion ${iri(work.mainVersion)} ; rv:sourceVersionStatus rv:Unresolved ;
        rv:translationStatus rv:ThirdParty ; rv:contentLanguage ${lit('zh-Hant')} ;
        rv:translator ${iri(editor.actor)} ; rv:publisher ${iri(editor.actor)} ;
        rv:evidence ${lit('https://example.com/legacy-source')} ; rv:linkedBy ${iri(editor.actor)} ;
        rv:modelRevision <https://rezics.com/definition/translation-link-v1> ;
        rv:shapeRevision <https://rezics.com/definition/translation-link-v1> ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ;
        rv:sequence 1 .
    } }`);
    const native = text(editor, work.work, 'en');
    await json(await saveText(editor, work.work, native));
    const all = await json<{ items: { id: string; legacy: object | null }[] }>(await stack.call('GET', `${root(work.work)}/realizations`));
    expect(new Set(all.items.map(item => item.id))).toEqual(new Set([native.id, linked.link]));
    const adapted = await json(await stack.call('GET', `${root(work.work)}/realizations/${linked.link.slice(-36)}`));
    expect(adapted).toMatchObject({ work: work.work, language: 'zh-Hant', status: 'unofficial', verification: 'unverified',
      legacy: { targetWork: target.work, targetMainRevision: mainRevision, sourceMainRevision: null } });
    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await json<{ items: { id: string }[]; nextCursor: string | null }>(await stack.call('GET',
        `${root(work.work)}/realizations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      pages.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(pages)).toEqual(new Set([native.id, linked.link]));

    const oldRelease = id();
    const oldBody: ReleaseWrite = {
      profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: oldRelease,
      kind: 'formal', status: 'official', contentLanguages: ['ja'], isTranslation: false, originalLanguages: [],
      titleLanguage: 'ja', tracklistLanguage: null, title: { value: '旧刊', language: 'ja' }, editionStatement: null,
      publisher: null, publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
    };
    const oldSaved = await json<WriteResult>(await editor.send('PUT', `${root(work.work)}/releases/${oldRelease.slice(-36)}`, oldBody));
    const invalidV1Key = `invalid-v1-${randomUUID()}`;
    const invalidV1 = { ...oldBody, expectedHead: oldSaved.revision, contentLanguages: ['ja', 'en'], evidence: id() };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await editor.send('PUT', `${root(work.work)}/releases/${oldRelease.slice(-36)}`,
        invalidV1, invalidV1Key)).status).toBe(400);
    }
    expect((await stack.accessPool.query('SELECT id FROM access.admission WHERE idempotency_key = $1', [invalidV1Key])).rowCount).toBe(0);
    expect(await json(await stack.call('GET', `${root(work.work)}/releases/${oldRelease.slice(-36)}`)))
      .toMatchObject({ profile: 'release-v2', coverage: [{ work: work.work, mainVersion: work.mainVersion,
        realization: null, revision: null, completeness: 'unknown', language: null }] });

    const hidden = await stack.privateWork(editor.actor, 'Private covered Work');
    await editor.grant(`work:edit:${hidden.work}`, 'work.edit');
    const secretText = text(editor, hidden.work, 'en');
    const saved = await json<WriteResult>(await saveText(editor, hidden.work, secretText));
    const publicText = text(editor, work.work, 'en');
    const publicSaved = await json<WriteResult>(await saveText(editor, work.work, publicText));
    const mixed = release(editor, [covered(publicText, publicSaved), covered(secretText, saved)], { isbn13: '9780316371247' });
    await json(await saveRelease(editor, work.work, mixed));
    const owners = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(mixed.id)} rv:work ?work } }`)).results!.bindings;
    expect(owners.map(row => row.work!.value)).toEqual([work.work]);
    expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(mixed.id)} rv:coverageWork ${iri(hidden.work)}, ${iri(work.work)} } }`)).boolean).toBe(true);
    const observer = await stack.member('observer');
    for (const response of [await stack.call('GET', `/v1/resources/${mixed.id.slice(-36)}`),
      await observer.read(`/v1/resources/${mixed.id.slice(-36)}`),
      await stack.call('GET', `/v1/public-previews/${mixed.id.slice(-36)}`),
      await stack.call('POST', '/v1/resources/summaries', { body: { profile: 'resource-summary-batch-v1', resources: [mixed.id] } })]) {
      // Unavailable is also a valid disclosure result; older readers do not yet
      // recognize Releases. The merged resource reader must keep the same fence.
      expect([200, 404]).toContain(response.status);
      const summary = await json(response, response.status);
      expect(JSON.stringify(summary)).not.toContain('Private covered Work');
      expect(JSON.stringify(summary)).not.toContain(hidden.work);
    }
    expect((await stack.call('GET', `${root(work.work)}/releases/${mixed.id.slice(-36)}`)).status).toBe(404);
    expect((await json<{ items: { id: string }[] }>(await stack.call('GET', '/v1/releases?isbn13=9780316371247')))
      .items.map(item => item.id)).not.toContain(mixed.id);
    expect((await stack.call('GET', `${root(hidden.work)}/realizations/${secretText.id.slice(-36)}`)).status).toBe(404);
  } finally { await stack.stop(); }
}, 120_000);
