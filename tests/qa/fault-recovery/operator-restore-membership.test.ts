import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  accessFence,
  operatorAttempt,
  ownerLogins,
  ownerRestoreErasureFixture,
} from './owner-restore-erasure-fixture.ts';
import {
  readMembershipCompletionProof,
  recipeApiJson,
  seedRecipeBeforeCut,
  shortId,
  type RecipeSeed,
  type StepQualifier,
} from './operator-restore-recipe-support.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';

test(
  'OPS03: populated Recipe membership is prepared on the restored epoch before logins and edits resume',
  async () => {
    const fixtureStarted = Date.now();
    let recipeSeed: RecipeSeed | undefined;
    const fixture = await ownerRestoreErasureFixture({
      beforeCutApiSeed: async (context) => {
        recipeSeed = await seedRecipeBeforeCut(context);
      },
    });
    try {
      if (!recipeSeed) throw new Error('Recipe API seed did not complete');
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();

      const copy = await fixture.copy();
      try {
        expect(fixture.beforeCutMembershipProof).toMatchObject({
          dataEpoch: fixture.sourceLineage.dataEpoch,
          revision: 'ordered-membership-v1',
        });
        const oldProof = await readMembershipCompletionProof(copy.fuseki);
        expect(oldProof).toEqual(fixture.beforeCutMembershipProof);
        expect(oldProof?.dataEpoch).not.toBe(copy.lineage.dataEpoch);
        expect(await copy.fuseki.membershipPreparationStatus()).toEqual({
          needsPreparation: true,
        });

        const actualPrepare = copy.fuseki.membershipPrepare.bind(copy.fuseki);
        let preparationInterrupted = false;
        const interruptedPrepare = spyOn(copy.fuseki, 'membershipPrepare').mockImplementation(
          async (input, signal) => {
            if (!preparationInterrupted) {
              preparationInterrupted = true;
              throw new Error('simulated membership preparation interruption');
            }
            return actualPrepare(input, signal);
          },
        );
        const key = randomUUID();
        try {
          await expect(operatorAttempt(fixture, copy, key)).rejects.toThrow(
            'simulated membership preparation interruption',
          );
          expect(preparationInterrupted).toBe(true);
          expect(await copy.fuseki.membershipPreparationStatus()).toEqual({
            needsPreparation: true,
          });
          expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
          expect(await accessFence(copy)).toEqual([
            { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
          ]);
        } finally {
          interruptedPrepare.mockRestore();
        }

        await operatorAttempt(fixture, copy, key);
        expect(await copy.fuseki.membershipPreparationStatus()).toEqual({
          needsPreparation: false,
        });
        expect(await readMembershipCompletionProof(copy.fuseki)).toEqual({
          dataEpoch: copy.lineage.dataEpoch,
          revision: 'ordered-membership-v1',
        });
        expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
          true,
          true,
          true,
          true,
        ]);
        expect((await copy.ready()).status).toBe(200);

        const compositionPath = `/v1/compositions/${shortId(recipeSeed.structure)}`;
        const query = `?actingSubject=${encodeURIComponent(fixture.actor)}`;
        const initial = await recipeApiJson<{
          revision: string;
          occurrences: OccurrenceRecord[];
        }>(await copy.recipeRequest('GET', `${compositionPath}${query}`), 200);
        expect(initial.revision).toBe(recipeSeed.initialRevision);
        expect(initial.occurrences.map((item) => item.occurrence)).toEqual([
          ...recipeSeed.ingredientOccurrences,
          recipeSeed.stepOccurrence,
        ]);

        const duplicateFlour = recipeSeed.ingredients[0];
        const inserts = await recipeApiJson<{ revision: string; occurrences: string[] }>(
          await copy.recipeRequest(
            'POST',
            `${compositionPath}/changes`,
            {
              profile: 'recipe-composition',
              expectedHead: initial.revision,
              actingSubject: fixture.actor,
              operations: [
                {
                  op: 'insert',
                  parent: recipeSeed.structure,
                  position: 'last',
                  role: 'ingredient',
                  sourceKey: 'restored-duplicate-flour-a',
                  qualifier: duplicateFlour,
                },
                {
                  op: 'insert',
                  parent: recipeSeed.structure,
                  position: 'last',
                  role: 'ingredient',
                  sourceKey: 'restored-duplicate-flour-b',
                  qualifier: duplicateFlour,
                },
              ],
            },
            `restore-recipe-inserts-${randomUUID()}`,
          ),
          200,
        );
        expect(inserts.occurrences).toHaveLength(2);
        expect(new Set(inserts.occurrences).size).toBe(2);

        const editedStep: StepQualifier = {
          ...recipeSeed.step,
          instructionText: { value: 'Whisk the retained flour until smooth.', language: 'en' },
        };
        const edited = await recipeApiJson<{ revision: string; occurrences: string[] }>(
          await copy.recipeRequest(
            'POST',
            `${compositionPath}/changes`,
            {
              profile: 'recipe-composition',
              expectedHead: inserts.revision,
              actingSubject: fixture.actor,
              operations: [
                {
                  op: 'update',
                  occurrence: recipeSeed.stepOccurrence,
                  qualifier: editedStep,
                },
              ],
            },
            `restore-recipe-qualifier-${randomUUID()}`,
          ),
          200,
        );
        expect(edited.occurrences).toEqual([]);

        const stale = await copy.recipeRequest(
          'POST',
          `${compositionPath}/changes`,
          {
            profile: 'recipe-composition',
            expectedHead: recipeSeed.initialRevision,
            actingSubject: fixture.actor,
            operations: [
              {
                op: 'insert',
                parent: recipeSeed.structure,
                position: 'last',
                role: 'ingredient',
                sourceKey: 'stale-recipe-head-insert',
                qualifier: recipeSeed.ingredients[1],
              },
            ],
          },
          `restore-recipe-stale-${randomUUID()}`,
        );
        expect(stale.status).toBe(409);

        const final = await recipeApiJson<{
          revision: string;
          occurrences: OccurrenceRecord[];
        }>(await copy.recipeRequest('GET', `${compositionPath}${query}`), 200);
        expect(final.revision).toBe(edited.revision);
        const expectedOccurrences = [
          ...recipeSeed.ingredientOccurrences,
          recipeSeed.stepOccurrence,
          ...inserts.occurrences,
        ].sort();
        const finalOccurrences = final.occurrences.map((item) => item.occurrence).sort();
        expect(finalOccurrences).toHaveLength(expectedOccurrences.length);
        expect(finalOccurrences).toEqual(expectedOccurrences);
        for (const [index, occurrence] of recipeSeed.ingredientOccurrences.entries()) {
          expect(final.occurrences.find((item) => item.occurrence === occurrence)?.qualifier).toEqual(
            recipeSeed.ingredients[index],
          );
        }
        expect(
          final.occurrences.find((item) => item.occurrence === recipeSeed.stepOccurrence)?.qualifier,
        ).toEqual(editedStep);
        for (const occurrence of inserts.occurrences) {
          expect(final.occurrences.find((item) => item.occurrence === occurrence)?.qualifier).toEqual(
            duplicateFlour,
          );
        }

        const scaled = await recipeApiJson<{
          ingredients: Array<{ amount?: { numerator: number; denominator: number } }>;
        }>(
          await copy.recipeRequest(
            'POST',
            `/v1/recipes/${shortId(recipeSeed.structure)}/scalings`,
            { actingSubject: fixture.actor, factor: { numerator: 2, denominator: 1 } },
          ),
          200,
        );
        expect(scaled.ingredients).toHaveLength(4);
        expect(scaled.ingredients.map((item) => item.amount)).toEqual([
          { numerator: 3, denominator: 1 },
          { numerator: 1, denominator: 2 },
          { numerator: 3, denominator: 1 },
          { numerator: 3, denominator: 1 },
        ]);
        console.info('operator restore membership case passed', {
          case: 'populated-recipe-recovery',
          inserts: inserts.occurrences.length,
          originalOccurrencesRetained: recipeSeed.ingredientOccurrences.length + 1,
        });
      } finally {
        await copy.dispose();
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('operator restore membership fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
