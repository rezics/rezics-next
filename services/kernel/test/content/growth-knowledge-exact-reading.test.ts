import '../../src/http/kernel.ts';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { documentText, normalizeDocument } from '@rezics/document';
import { KNOWLEDGE_REFERENCE_DEFINITION, type KnowledgeReference } from '../../src/content/knowledge-portable.ts';
import exactSelection from '../../src/content/knowledge-public-exact-selection.sql';
import publicRead from '../../src/content/knowledge-public-read.sql';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  measure,
  medianCost,
  openGrowthDatabase,
  settle,
  type Cost,
  type GrowthCheck,
  type GrowthDatabase,
  type RelationSize,
} from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(1_800_000);
type Saved = { documentId: string; revisionId: string };
const accessPaths = [
  'content.knowledge_document',
  'content.knowledge_notebook',
  'content.knowledge_revision',
  'content.knowledge_publication_selection',
] as const;
// Reylo's Standard Query exposes the PostgreSQL text, including its dispatch comment, and binding order.
const exactSelectionQuery = exactSelection['~standard'].query;
const publicReadQuery = publicRead['~standard'].query;

function input(title: string, reference?: KnowledgeReference) {
  return {
    title,
    licence: 'MIT',
    subjectIds: [],
    references: reference ? [reference] : [],
    body: normalizeDocument({
      version: 'rezics-document-v1',
      profile: 'blocks',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'statement' },
            content: [
              { type: 'text', text: title },
              ...(reference
                ? [
                    {
                      type: 'extensionInline',
                      attrs: {
                        id: 'citation',
                        definition: KNOWLEDGE_REFERENCE_DEFINITION,
                        version: '1',
                        payload: { referenceId: reference.id },
                        fallback: 'Exact statement',
                      },
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    }),
  };
}

async function measureOwnerScales(db: GrowthDatabase, check: GrowthCheck, scales: readonly number[]) {
  let previous = 0;
  let repetition = 0;
  const samples = [];
  for (const scale of scales) {
    await check.grow(db, scale, previous);
    await settle(db, { analyze: true, relations: check.seededRelations! });
    await check.operation(db, scale, repetition++);
    const repetitions: Cost[] = [];
    for (let run = 0; run < 5; run++) {
      const { cost } = await measure(db, () => check.operation(db, scale, repetition++));
      repetitions.push(cost);
    }
    const footprint = await db.admin.query<RelationSize & { relation: string }>(
      `SELECT 'content.' || relname AS relation, relpages, reltuples
       FROM pg_class WHERE oid = ANY($1::regclass[])`,
      [accessPaths],
    );
    const relationSizes = Object.fromEntries(footprint.rows.map(({ relation, ...size }) => [relation, size]));
    samples.push({ scale, cost: medianCost(repetitions), repetitions, relationSizes });
    previous = scale;
  }
  return samples;
}

for (const axis of ['private attachments', 'theorem revision history'] as const) {
  const ownerScales = axis === 'private attachments' ? [1, 1_000, 100_000] : [1_000, 10_000, 100_000];
  test(`native exact solution reads stay bounded as ${axis} grow`, () => exactReading());
  test(`native exact solution reads stay bounded at the 100,000-row scale for ${axis}`, () => exactReading(ownerScales));

  async function exactReading(scales?: readonly number[]) {
    const f = await postPublicationFixture();
    try {
      const { subject } = await f.command('/v1/subjects', {
        type: 'skos:Concept',
        labels: { en: 'Exact reading growth' },
      });
      const notebook = await f.command('/v1/knowledge/notebooks', {
        subjectId: subject.id,
        title: 'Exact growth notebook',
      });
      let structure = notebook.structureRevisionId as string;
      const documentPath = ({ documentId }: Saved) => `/v1/knowledge/documents/${documentId}`;
      const exactPath = (saved: Saved) => `${documentPath(saved)}?revisionId=${saved.revisionId}`;
      async function create(text: string, reference?: KnowledgeReference): Promise<Saved> {
        const saved = await f.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
          ...input(text, reference),
          parentPlacementId: null,
          expectedStructureRevisionId: structure,
        });
        structure = saved.structureRevisionId;
        return saved as Saved;
      }
      async function select(saved: Saved, previous: string | null) {
        return f.command(
          `${documentPath(saved)}/publication:select`,
          {
            expectedHeadRevisionId: saved.revisionId,
            expectedPublicationId: previous,
            revisionId: saved.revisionId,
          },
          200,
        );
      }
      async function citation(id: string, target: Saved): Promise<KnowledgeReference> {
        const result = await f.call('GET', exactPath(target), undefined, { anonymous: true });
        expect(result.status, JSON.stringify(result.value)).toBe(200);
        return {
          id,
          role: 'uses',
          sourceBlockId: 'statement',
          target: {
            kind: 'revision',
            documentId: target.documentId,
            revisionId: target.revisionId,
            sha256: result.value.document.sourceSha256,
            blockId: 'statement',
          },
        };
      }

      const definition = await create('A bound holds for every term.');
      await select(definition, null);
      const theorem = await create('Use the bound on the tail.', await citation('theorem-uses-definition', definition));
      const oldPublication = await select(theorem, null);
      const solutionReference = await citation('solution-uses-theorem', theorem);
      const solution = await create('Combine the bounds on prefix and tail.', solutionReference);
      const { publicationId: solutionPublicationId } = await select(solution, null);
      const revise = async (saved: Saved, title: string) =>
        (await f.command(
          `${documentPath(saved)}/revisions:revise`,
          {
            ...input(title),
            expectedHeadRevisionId: saved.revisionId,
          },
          200,
        )) as Saved;
      const hidden = await revise(theorem, 'A private intermediate draft');
      const head = await revise(hidden, 'The later public assumption');
      await select(head, oldPublication.publicationId);
      const route = routeOf(theorem.documentId)!;
      expect(routeOf(notebook.notebookId)).toBe(route);
      const selectionBindings = [solution, theorem, theorem, solution, hidden].map(({ documentId, revisionId }) =>
        exactSelectionQuery.encode({ route, document_id: documentId, revision_id: revisionId }),
      );
      const bodyBindings = publicReadQuery.encode({
        route,
        document_id: solution.documentId,
        publication_id: solutionPublicationId,
      });

      const db = await openGrowthDatabase(f.pool.options.connectionString);
      try {
        const kernel = createKernel({
          pool: db.pool,
          access: f.system.access,
          routeKey: f.system.routeKey,
          tokens: f.system.tokenKeys,
          receiptKeys: testReceiptKeys(),
        });
        const observer = observeSql(db.pool);
        try {
          const name = `Knowledge exact source and concealed revision / ${axis}${scales ? ' / owner scales' : ''}`;
          const readyPath = exactPath(solution);
          const hiddenPath = exactPath(hidden);
          let baseline: string | undefined;
          let concealedBytes: number | undefined;
          const timings: { scale: number; elapsedMs: number; responseBytes: number }[] = [];
          let sampledPeakRssBytes = 0;
          async function seedBatch(database: GrowthDatabase, count: number) {
            const ids = Array.from({ length: count }, () => newId(route));
            if (axis === 'private attachments') {
              // Same hot account and Subject, separate empty notebooks. Their headers are real
              // private attachment rows, with a baseline structure revision and no publication.
              const revisions = ids.map(() => newId(route));
              const seed = await database.admin.connect();
              try {
                await seed.query('BEGIN');
                const notebooks = await seed.query(
                  `INSERT INTO content.knowledge_notebook
                     (route,notebook_id,owner_account_id,subject_id,title,structure_revision_id,created_transaction_id,created_at)
                   SELECT n.route,ids.id,n.owner_account_id,n.subject_id,'Never published adjacent notebook',
                          ids.revision_id,n.created_transaction_id,n.created_at
                   FROM content.knowledge_notebook n CROSS JOIN unnest($3::uuid[],$4::uuid[]) ids(id,revision_id)
                   WHERE n.route=$1 AND n.notebook_id=$2`,
                  [route, notebook.notebookId, ids, revisions],
                );
                const history = await seed.query(
                  `INSERT INTO content.knowledge_structure_revision
                     (route,notebook_id,revision_id,recorded_transaction_id,created_at,history_complete,change_kind)
                   SELECT n.route,n.notebook_id,n.structure_revision_id,n.created_transaction_id,n.created_at,true,'notebook_created'
                   FROM content.knowledge_notebook n WHERE n.route=$1 AND n.notebook_id=ANY($2::uuid[])`,
                  [route, ids],
                );
                expect(notebooks.rowCount).toBe(count);
                expect(history.rowCount).toBe(count);
                await seed.query('COMMIT');
              } catch (error) {
                await seed.query('ROLLBACK');
                throw error;
              } finally {
                seed.release();
              }
            } else {
              // Immutable retained history under the exact same theorem key; its head and publications stay fixed.
              const inserted = await database.admin.query(
                `INSERT INTO content.knowledge_revision
                   (route,document_id,revision_id,title,language,canonical_bytes,body_sha256,licence,subject_ids,
                    author_account_id,recorded_transaction_id,created_at,reference_manifest,copy_provenance,media_ids)
                 SELECT r.route,r.document_id,ids.id,r.title,r.language,r.canonical_bytes,r.body_sha256,r.licence,r.subject_ids,
                        r.author_account_id,r.recorded_transaction_id,r.created_at,r.reference_manifest,r.copy_provenance,r.media_ids
                 FROM content.knowledge_revision r CROSS JOIN unnest($4::uuid[]) ids(id)
                 WHERE r.route=$1 AND r.document_id=$2 AND r.revision_id=$3`,
                [route, theorem.documentId, hidden.revisionId, ids],
              );
              expect(inserted.rowCount).toBe(count);
            }
          }
          const check: GrowthCheck = {
            name,
            scales: [64, 512, 4096],
            rule: 'series',
            bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
            byteBounds: { responseBytes: 'constant' },
            seededRelations:
              axis === 'private attachments'
                ? ['content.knowledge_notebook', 'content.knowledge_structure_revision']
                : ['content.knowledge_revision'],
            async grow(database, scale, previous) {
              // Each private attachment writes two rows. Keep each seed transaction within 500 rows.
              for (let offset = previous; offset < scale; offset += 250)
                await seedBatch(database, Math.min(250, scale - offset));
            },
            async operation(_db, scale) {
              const start = observer.records.length;
              const began = performance.now();
              const ready = await kernel.handle(new Request(`https://content.test${readyPath}`));
              const body = await ready.text();
              const missing = await kernel.handle(new Request(`https://content.test${hiddenPath}`));
              const concealed = await missing.text();
              const hiddenResponseBytes = Buffer.byteLength(concealed);
              timings.push({
                scale,
                elapsedMs: performance.now() - began,
                responseBytes: Buffer.byteLength(body) + hiddenResponseBytes,
              });
              sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);

              expect(ready.status, body).toBe(200);
              baseline ??= body;
              expect(body).toBe(baseline);
              const { document } = JSON.parse(body);
              expect(document.revisionId).toBe(solution.revisionId);
              expect(document.references).toEqual([solutionReference]);
              expect(
                documentText(JSON.parse(Buffer.from(document.canonicalBytes, 'base64').toString('utf8'))),
              ).toContain('Combine the bounds on prefix and tail.');
              expect(missing.status, concealed).toBe(404);
              expect(concealed).not.toContain('A private intermediate draft');
              concealedBytes ??= hiddenResponseBytes;
              expect(hiddenResponseBytes).toBe(concealedBytes);

              // Source selection/recheck, two target authority probes, and one concealed point read.
              // Only the source loads bytes. Resolving the theorem never follows its definition.
              const records = observer.records.slice(start);
              expect(records.length, 'Native SQL observer captured no request queries').toBeGreaterThan(0);
              // pg receives these scalar keys before converting them to PostgreSQL text parameters.
              const probes = records
                .filter((r) => r.statement === exactSelectionQuery.text)
                .map((r) => r.parameters.map(String));
              expect(probes).toEqual(selectionBindings);
              const sourceBodies = records
                .filter((r) => r.statement === publicReadQuery.text)
                .map((r) => r.parameters.map(String));
              expect(sourceBodies).toEqual([bodyBindings]);
            },
          };
          const samples = scales ? await measureOwnerScales(db, check, scales) : (await checkGrowth(db, check)).samples;
          console.info(
            JSON.stringify({
              name,
              timings,
              sampledPeakRssBytes,
              samples: samples.map(({ scale, cost, relationSizes }) => ({ scale, cost, relationSizes })),
            }),
          );
          assertGrowthAccessPaths(name, samples, accessPaths);
          if (scales) {
            const first = samples[0]!;
            expect(first.cost.rows).toBeGreaterThan(0);
            expect(first.cost.statements).toBeGreaterThan(0);
            expect(first.cost.responseBytes ?? 0).toBeGreaterThan(0);
            for (const { scale, cost } of samples) {
              const context = `${name} at ${scale} added rows`;
              expect(cost.rows, context).toBeLessThanOrEqual(first.cost.rows);
              expect(cost.statements, context).toBe(first.cost.statements);
              expect(cost.responseBytes, context).toBe(first.cost.responseBytes!);
              // Budget one extra B-tree page per tenfold increase for each of the
              // five authority probes and the source body read.
              const extraBlocks = 6 * Math.ceil(Math.log10(scale / first.scale));
              expect(cost.blocks, context).toBeLessThanOrEqual(first.cost.blocks + extraBlocks);
            }
          }
        } finally {
          await observer.close();
        }
      } finally {
        await db.close();
      }
    } finally {
      await f.close();
    }
  }
}
