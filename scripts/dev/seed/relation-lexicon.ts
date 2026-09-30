import { relationLexiconSeed, type LexiconSeedDefinition } from './relation-lexicon-data.ts';
import type { SeedApi } from './api.ts';

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

/** Use the normal public-API transport, including its pending-receipt retry behavior. */
export function loadRelationLexicon(
  api: Pick<SeedApi, 'post'>,
  token: () => Promise<string>,
  actingSubject: string,
  namespace: string,
  authorizeDefinition: SeedLexiconClient['authorizeDefinition'],
) {
  return seedRelationLexicon(
    {
      post: async <T>(path: string, body: object, key: string) =>
        api.post<T>(path, body, await token(), key),
      authorizeDefinition,
    },
    actingSubject,
    namespace,
  );
}

/** Reusable production bootstrap; replayed API receipts resume an interrupted run. */
export async function seedRelationLexicon(
  client: SeedLexiconClient,
  actingSubject: string,
  namespace: string,
  data: readonly LexiconSeedDefinition[] = relationLexiconSeed,
) {
  if (!/^[A-Za-z0-9:_./-]{1,48}$/.test(namespace))
    throw new Error('lexicon seed namespace is invalid');
  const definitions: { key: string; component: string; revision: string }[] = [];
  for (const definition of data) {
    const key = `${namespace}:lexicon:${definition.key}`;
    const receipt = await client.post<SeedLexiconReceipt>(
      '/v1/semantic/changes',
      {
        profile: 'semantic-change-v1',
        actingSubject,
        expectedHead: null,
        state: {
          component: 'definition',
          kind: 'relation',
          roles: definition.roles.map((role) => ({
            key: role,
            minParticipants: 1,
            maxParticipants: 64,
            ordered: false,
          })),
        },
      },
      `${key}:meaning`,
    );
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
              plurals: { one: label, other: heading },
              grammaticalForms: [],
              source: 'https://rezics.com/definition/relation-lexicon-seed-v1',
              licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
              reviewStatus: 'draft',
            },
          },
          `${key}:${language}:${index}`,
        );
    }
    definitions.push({ key: definition.key, ...receipt });
  }
  return definitions;
}
