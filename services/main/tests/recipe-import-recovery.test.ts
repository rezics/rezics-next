import { expect, spyOn, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import * as admitted from '../src/modules/structure/change-admitted.ts';
import {
  checkedOperations,
  compositionChangeDigest,
  StaleCompositionHead,
} from '../src/modules/structure/change.ts';
import { checkOccurrenceRecord, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import * as graph from '../src/modules/structure/graph.ts';
import { IdempotencyConflict } from '../src/modules/work/activate.ts';
import { PendingAdmittedWork } from '../src/modules/work/create-admitted.ts';
import * as lineage from '../src/modules/work/restore-lineage.ts';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import { SourceIntakeConflict } from '../src/modules/source/intake.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { recipeRoutes } from '../src/routes/recipes.ts';

type ImportInput = { key?: string; expectedHead?: string };
type Interruption = 'concurrent-edit' | 'lost-response' | 'authority-expired';
type ImportSurface = 'file' | 'retained';

export interface RecipeImportFixture {
  structure: string;
  initialHead: string;
  sourceObservation: string;
  readonly head: string;
  records: OccurrenceRecord[];
  keys: string[];
  receipts: string[];
  importFile(source: unknown, input?: ImportInput): Promise<Response>;
  importRetained(source: unknown, input?: ImportInput): Promise<Response>;
  interruptAfter(batch: 'groups.0' | 'content.0', kind: Interruption): void;
  editConcurrently(): void;
  restoreAuthority(): void;
}

/**
 * Exercise the real HTTP orchestration, parser and Composition normalization. The owner
 * boundary models committed receipts, exact request identity and stale-head admission;
 * interruptions happen only after a batch has committed, never instead of a write.
 */
export async function withRecipeImportFixture<T>(
  run: (fixture: RecipeImportFixture) => Promise<T>,
): Promise<T> {
  const id = (name: string) => graph.derivedId(`recipe-import-recovery:${name}`);
  const structure = id('structure'),
    owner = id('owner'),
    actingSubject = id('subject');
  const initialHead = id('initial-head'),
    sourceObservation = id('source-observation');
  const records: OccurrenceRecord[] = [],
    keys: string[] = [],
    receipts: string[] = [];
  const committed = new Map<string, admitted.AdmittedComposition>();
  const retained = new Map<string, { bytes: string; sourceRevision: string }>();
  let head = initialHead,
    sequence = 0,
    authority = true,
    source: unknown;
  let interruption: { batch: string; kind: Interruption } | undefined;

  const editConcurrently = () => {
    head = id(`concurrent-revision:${++sequence}`);
    const record: OccurrenceRecord = {
      occurrence: id(`concurrent-step:${sequence}`),
      state: 'active',
      parent: structure,
      segmentKey: 'a',
      orderKey: String(records.length).padStart(8, '0'),
      role: 'step',
      labels: [],
      introducedBy: head,
      qualifier: {
        type: 'recipe-step',
        instructionText: { value: 'Keep the other editor’s note.', language: 'en' },
        usesIngredient: [],
        media: [],
        scaling: 'linear',
      },
    };
    checkOccurrenceRecord(record, 'recipe-composition');
    records.push(record);
  };
  const assertAuthority = async () => {
    if (!authority) throw new AdmissionDenied('The Recipe edit grant expired between batches');
  };
  const observation = () => ({
    observation: sourceObservation,
    mediaType: 'application/json',
    rawBytesBase64: Buffer.from(JSON.stringify(source)).toString('base64'),
    coverage: { scope: 'recipe-file-import', complete: true, omittedFields: [] },
  });
  const restoreHeader = spyOn(graph, 'readCompositionHeader').mockImplementation(async () => ({
    structure,
    profile: 'recipe-composition',
    owner,
    component: owner,
    work: owner,
    mainVersion: owner,
    head,
    generation: id('generation'),
    placementCount: records.length,
    manifest: `urn:rezics:sha256:${'a'.repeat(64)}`,
  }));
  const restoreFence = spyOn(lineage, 'assertGraphAdmissionOpen').mockResolvedValue(undefined);
  const restoreChange = spyOn(admitted, 'changeAdmittedComposition').mockImplementation(
    async (_environment, _account, _access, _request, input) => {
      keys.push(input.idempotencyKey);
      const operations = checkedOperations(input.operations, 'recipe-composition');
      const digest = compositionChangeDigest(
        input.structure,
        input.expectedHead,
        operations,
        'recipe-composition',
      );
      await assertAuthority();
      const prior = committed.get(input.idempotencyKey);
      if (prior) {
        if (prior.requestDigest !== digest)
          throw new IdempotencyConflict('A retry changed its original intent');
        return { ...prior, replayed: true };
      }
      if (head !== input.expectedHead)
        throw new StaleCompositionHead('Another edit advanced the Composition');
      const revision = id(`revision:${input.idempotencyKey}`);
      const inserted = operations.map((operation, index): OccurrenceRecord => {
        if (operation.op !== 'insert')
          throw new Error('This import fixture expects occurrence inserts');
        const record: OccurrenceRecord = {
          occurrence: graph.derivedId(`${revision}\0occurrence\0${index}`),
          state: 'active',
          parent: operation.parent,
          segmentKey: 'a',
          orderKey: String(records.length + index).padStart(8, '0'),
          role: operation.role,
          labels: operation.label ? [operation.label] : [],
          introducedBy: revision,
          ...(operation.qualifier ? { qualifier: operation.qualifier } : {}),
          ...(operation.sourceKey ? { sourceKey: operation.sourceKey } : {}),
        };
        checkOccurrenceRecord(record, 'recipe-composition');
        return record;
      });
      records.push(...inserted);
      head = revision;
      const receipt = `urn:rezics:receipt:${input.idempotencyKey}`;
      const result: admitted.AdmittedComposition = {
        outcome: 'succeeded',
        receipt,
        admissionId: id(`admission:${input.idempotencyKey}`),
        requestDigest: digest,
        authorityEpoch: '1',
        scope: `work:edit:${owner}`,
        dataEpoch: 'recipe-import-fixture',
        sequence: String(++sequence),
        structure,
        revision,
        expectedHead: input.expectedHead,
        replayed: false,
        occurrences: inserted.map((record) => record.occurrence),
      };
      committed.set(input.idempotencyKey, result);
      receipts.push(receipt);
      if (interruption && input.idempotencyKey.endsWith(`.${interruption.batch}`)) {
        const kind = interruption.kind;
        interruption = undefined;
        if (kind === 'authority-expired') authority = false;
        else {
          editConcurrently();
          if (kind === 'lost-response')
            throw new PendingAdmittedWork(result.admissionId, 'work-edit');
        }
      }
      return result;
    },
  );
  try {
    const dependencies = {
      environment: {
        fuseki: {},
        lineage: { dataEpoch: 'recipe-import-fixture', routingEpoch: '1' },
      },
      account: { verify: async () => ({ issuer: 'fixture', subject: 'recipe-editor' }) },
      access: {
        assertAuthority,
        activePrincipalId: async () => 'recipe-editor',
        canReadWork: async () => true,
      },
      sourceIntake: {
        replay: async (_principal: string, key: string) =>
          retained.has(key) ? observation() : null,
        submit: async (
          _principal: string,
          key: string,
          input: { rawBytesBase64: string; sourceRevision: string },
        ) => {
          const prior = retained.get(key);
          if (
            prior &&
            (prior.bytes !== input.rawBytesBase64 || prior.sourceRevision !== input.sourceRevision)
          ) {
            throw new SourceIntakeConflict('A file retry changed its original intent');
          }
          retained.set(key, { bytes: input.rawBytesBase64, sourceRevision: input.sourceRevision });
          return { observation: observation(), replayed: Boolean(prior) };
        },
        read: async () => observation(),
      },
    } as unknown as MainWorkDependencies;
    const app = recipeRoutes({} as FusekiClient, dependencies);
    const fixture: RecipeImportFixture = {
      structure,
      initialHead,
      sourceObservation,
      get head() {
        return head;
      },
      records,
      keys,
      receipts,
      interruptAfter: (batch, kind) => {
        interruption = { batch, kind };
      },
      editConcurrently,
      restoreAuthority: () => {
        authority = true;
      },
      importFile: async (value, input = {}) => {
        source = value;
        const query = new URLSearchParams({
          actingSubject,
          expectedHead: input.expectedHead ?? initialHead,
        });
        return app.handle(
          new Request(
            `http://main.local/v1/recipes/${structure.split('/').at(-1)}/file-imports?${query}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': input.key ?? 'recipe-import-intent',
              },
              body: JSON.stringify(value),
            },
          ),
        );
      },
      importRetained: async (value, input = {}) => {
        source = value;
        return app.handle(
          new Request(`http://main.local/v1/recipes/${structure.split('/').at(-1)}/imports`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': input.key ?? 'recipe-import-intent',
            },
            body: JSON.stringify({
              sourceObservation,
              actingSubject,
              expectedHead: input.expectedHead ?? initialHead,
            }),
          }),
        );
      },
    };
    return await run(fixture);
  } finally {
    restoreChange.mockRestore();
    restoreFence.mockRestore();
    restoreHeader.mockRestore();
  }
}

const recipe = {
  '@type': 'Recipe',
  inLanguage: 'en',
  recipeIngredient: Array.from(
    { length: 17 },
    (_, index) => `${index + 1} g ingredient ${index + 1}`,
  ),
  recipeInstructions: Array.from({ length: 17 }, (_, index) => ({
    '@type': 'HowToSection',
    name: `Section ${index + 1}`,
    itemListElement: [{ '@type': 'HowToStep', text: `Do step ${index + 1}.` }],
  })),
};

function importOn(fixture: RecipeImportFixture, surface: ImportSurface, input?: ImportInput) {
  return surface === 'file'
    ? fixture.importFile(recipe, input)
    : fixture.importRetained(recipe, input);
}

function expectExactlyOnce(fixture: RecipeImportFixture, concurrentEdits: number) {
  const parsed = importRecipe(recipe, fixture.sourceObservation);
  const expectedKeys = [...parsed.sections, ...parsed.ingredients, ...parsed.steps]
    .map((row) => row.sourceKey)
    .sort();
  const imported = fixture.records.filter((record) => record.sourceKey);
  expect(imported.map((record) => record.sourceKey).sort()).toEqual(expectedKeys);
  expect(new Set(imported.map((record) => record.occurrence)).size).toBe(expectedKeys.length);
  expect(fixture.records.filter((record) => !record.sourceKey)).toHaveLength(concurrentEdits);
  expect(fixture.keys.every((key) => key.startsWith('recipe-import-intent.'))).toBe(true);
  for (const step of parsed.steps) {
    const record = imported.find((row) => row.sourceKey === step.sourceKey)!;
    const section = imported.find(
      (row) => row.sourceKey === parsed.sections[step.section]!.sourceKey,
    )!;
    expect(record.parent).toBe(section.occurrence);
  }
}

for (const surface of ['file', 'retained'] as const) {
  for (const batch of ['groups.0', 'content.0'] as const) {
    test(`${surface} Recipe import resumes the original intent after an edit following ${batch}`, async () => {
      await withRecipeImportFixture(async (fixture) => {
        fixture.interruptAfter(batch, 'concurrent-edit');
        const interrupted = await importOn(fixture, surface);
        expect([200, 201]).not.toContain(interrupted.status);
        expect(fixture.receipts.length).toBeGreaterThan(0);
        const recovered = await importOn(fixture, surface);
        expect(recovered.status).toBeLessThan(300);
        expectExactlyOnce(fixture, 1);
        const receiptCount = fixture.receipts.length;
        expect((await importOn(fixture, surface)).status).toBeLessThan(300);
        expect(fixture.receipts).toHaveLength(receiptCount);
        expectExactlyOnce(fixture, 1);
      });
    });
  }

  for (const batch of ['groups.0', 'content.0'] as const) {
    const prefixReceipts = batch === 'groups.0' ? 1 : 3;
    test(`${surface} Recipe import recovers a lost ${batch} response and preserves an intervening edit`, async () => {
      await withRecipeImportFixture(async (fixture) => {
        fixture.interruptAfter(batch, 'lost-response');
        const uncertain = await importOn(fixture, surface);
        expect(uncertain.status).not.toBe(200);
        expect(uncertain.status).not.toBe(201);
        expect(fixture.receipts).toHaveLength(prefixReceipts);
        const recovered = await importOn(fixture, surface);
        expect(recovered.status).toBeLessThan(300);
        expectExactlyOnce(fixture, 1);
      });
    });

    test(`${surface} Recipe import exposes durable partial progress when authority expires after ${batch}`, async () => {
      await withRecipeImportFixture(async (fixture) => {
        fixture.interruptAfter(batch, 'authority-expired');
        const interrupted = await importOn(fixture, surface);
        const partial = JSON.stringify(await interrupted.json());
        expect(fixture.receipts).toHaveLength(prefixReceipts);
        const beforeDeniedRetry = fixture.records.map((record) => record.occurrence);
        expect([200, 201]).not.toContain((await importOn(fixture, surface)).status);
        expect(fixture.records.map((record) => record.occurrence)).toEqual(beforeDeniedRetry);
        fixture.restoreAuthority();
        expect((await importOn(fixture, surface)).status).toBeLessThan(300);
        expectExactlyOnce(fixture, 0);
        // An untouched denial and a committed prefix require different recovery instructions.
        // The response must retain the original intent and receipts; field names are unconstrained.
        expect(partial).toContain('recipe-import-intent');
        for (const receipt of fixture.receipts.slice(0, prefixReceipts))
          expect(partial).toContain(receipt);
      });
    });
  }

  test(`${surface} Recipe import replays a lost final response without duplicating any committed occurrence`, async () => {
    await withRecipeImportFixture(async (fixture) => {
      // The client never consumes the first successful response.
      expect((await importOn(fixture, surface)).status).toBeLessThan(300);
      const receiptCount = fixture.receipts.length;
      fixture.editConcurrently();
      const replay = await importOn(fixture, surface);
      expect(replay.status).toBeLessThan(300);
      expect(fixture.receipts).toHaveLength(receiptCount);
      expectExactlyOnce(fixture, 1);
    });
  });

  test(`${surface} Recipe import refuses changing the expected head under an uncertain original key`, async () => {
    await withRecipeImportFixture(async (fixture) => {
      fixture.interruptAfter('content.0', 'lost-response');
      await importOn(fixture, surface);
      const before = fixture.records.map((record) => record.occurrence);
      const changedIntent = await importOn(fixture, surface, { expectedHead: fixture.head });
      expect(changedIntent.status).toBe(409);
      expect(await changedIntent.json()).toMatchObject({ code: 'idempotency_conflict' });
      expect(fixture.records.map((record) => record.occurrence)).toEqual(before);
    });
  });
}
