import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
type WriteResult = { revision: string; receipt: string; replayed: boolean };

async function json<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (response.status !== 200) throw new Error(`Expected committed 200, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('G826: external and native realization evidence commits as IRIs, reads unchanged and survives correction replay', async () => {
  const stack = await startMediaStack('g826-evidence');
  try {
    const editor = await stack.member('evidence-editor');
    const work = await stack.publicWork(editor.actor, ['ja'], 'Realization evidence');
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    for (const evidence of ['https://publisher.example/provenance?edition=1&lang=ja#text', id()]) {
      const body: RealizationWrite = { profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor,
        id: id(), language: 'en', kind: 'translation', translators: [editor.actor], publishers: [editor.actor],
        source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence };
      const path = `/v1/works/${work.work.slice(-36)}/realizations/${body.id.slice(-36)}`;
      const created = await json<WriteResult>(await editor.send('PUT', path, body));
      expect(created.replayed).toBe(false);
      expect(await json(await stack.call('GET', path))).toMatchObject({ id: body.id, evidence, revision: created.revision });

      const correctionEvidence = evidence.startsWith('https://publisher.example')
        ? 'https://publisher.example/corrections?edition=2#verification' : id();
      const correction = { ...body, expectedHead: created.revision, verification: 'unverified' as const,
        evidence: correctionEvidence };
      const key = `g826-correction-${randomUUID()}`;
      const corrected = await json<WriteResult>(await editor.send('PUT', path, correction, key));
      expect(corrected.replayed).toBe(false);
      expect(await json(await editor.send('PUT', path, correction, key)))
        .toMatchObject({ revision: corrected.revision, receipt: corrected.receipt, replayed: true });
      expect(await json(await stack.call('GET', path)))
        .toMatchObject({ evidence: correctionEvidence, revision: corrected.revision, verification: 'unverified' });

      for (const [saved, expectedEvidence] of [[created, evidence], [corrected, correctionEvidence]] as const) {
        const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?evidence ?revisionEvidence ?receiptEvidence WHERE {
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(saved.revision)} rv:evidence ?evidence ; rv:correctionEvidence ?revisionEvidence }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(saved.receipt)} rv:correctionEvidence ?receiptEvidence }
        } LIMIT 2`)).results!.bindings;
        expect(rows).toHaveLength(1);
        for (const name of ['evidence', 'revisionEvidence', 'receiptEvidence']) {
          expect(rows[0]![name]).toMatchObject({ type: 'uri', value: expectedEvidence });
        }
      }
    }
  } finally { await stack.stop(); }
}, 120_000);
