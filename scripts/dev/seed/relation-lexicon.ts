import { relationLexiconSeed, type LexiconSeedDefinition } from './relation-lexicon-data.ts';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SeedLexiconReceipt {
  component: string;
  revision: string;
}
export interface SeedLexiconClient {
  /** This transport calls Main's public API with the operator's bearer token. */
  post<T>(path: string, body: object, idempotencyKey: string): Promise<T>;
  /** Establish definition stewardship through the public authority API, when bootstrap needs it. */
  authorizeDefinition(receipt: SeedLexiconReceipt): Promise<void>;
}

/** Per-bootstrap mapping consumed by relation migrations; namespace slashes stay inside the filename. */
export function relationLexiconSeedMapPath(namespace: string): string {
  return resolve('.temp/seed/relation-lexicon', `${encodeURIComponent(namespace)}.json`);
}

/** Reusable production bootstrap; replayed API receipts resume an interrupted run. */
export async function seedRelationLexicon(
  client: SeedLexiconClient,
  actingSubject: string,
  namespace: string,
  data: readonly LexiconSeedDefinition[] = relationLexiconSeed,
  mappingFile = relationLexiconSeedMapPath(namespace),
) {
  if (!/^[A-Za-z0-9:_./-]{1,48}$/.test(namespace))
    throw new Error('lexicon seed namespace is invalid');
  const definitions: { key: string; component: string; revision: string }[] = [];
  for (const definition of data) {
    // The keyed, singleton-authority meaning differs from G-832's original body.
    // Keep old receipts replayable and bootstrap this revision under fresh keys.
    const key = `${namespace}:lexicon:v2:${definition.key}`;
    const receipt = await client.post<SeedLexiconReceipt>(
      '/v1/semantic/changes',
      {
        profile: 'semantic-change-v1',
        actingSubject,
        expectedHead: null,
        state: {
          component: 'definition',
          kind: 'relation',
          notation: definition.key,
          workSubjectRole: definition.roles.includes('work') ? 'work' : definition.roles[1],
          roles: definition.roles.map((role) => ({
            key: role,
            minParticipants: 1,
            maxParticipants: 1,
            ordered: false,
          })),
        },
      },
      `${key}:meaning`,
    );
    definitions.push({
      key: definition.key,
      component: receipt.component,
      revision: receipt.revision,
    });
    // Checkpoint IDs before labels or authorization can fail; retries recover the same API receipts.
    await mkdir(dirname(mappingFile), { recursive: true });
    await writeFile(
      `${mappingFile}.tmp`,
      `${JSON.stringify({ profile: 'relation-lexicon-seed-map-v1', namespace, definitions }, null, 2)}\n`,
    );
    await rename(`${mappingFile}.tmp`, mappingFile);
    await client.authorizeDefinition(receipt);
    for (const [language, noun, plural, inverseNoun, inversePlural] of definition.labels) {
      for (const [index, [fromRole, toRole, label, heading]] of [
        [definition.roles[0], definition.roles[1], noun, plural],
        [definition.roles[1], definition.roles[0], inverseNoun, inversePlural],
      ].entries())
        await client.post(
          '/v1/lexicon/presentations',
          {
            profile: 'definition-presentation-v1',
            actingSubject,
            expectedHead: null,
            state: {
              definition: receipt.component,
              meaningRevision: receipt.revision,
              fromRole,
              toRole,
              language,
              noun: label,
              heading,
              plurals: {
                ...(new Intl.PluralRules(language)
                  .resolvedOptions()
                  .pluralCategories.includes('one')
                  ? { one: label }
                  : {}),
                other: heading,
              },
              grammaticalForms: [],
              source: 'https://rezics.com/definition/relation-lexicon-seed-v1',
              licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
              reviewStatus: 'draft',
            },
          },
          `${key}:${language}:${index}`,
        );
    }
  }
  return definitions;
}
