import { relationLexiconSeed, type LexiconSeedDefinition } from './relation-lexicon-data.ts';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DefinitionState } from '../../../services/main/src/modules/semantic/change.ts';

export interface SeedLexiconReceipt {
  component: string;
  revision: string;
}
export interface SeedLexiconClient {
  /** This transport calls Main's public API with the operator's bearer token. */
  post<T>(path: string, body: object, idempotencyKey: string): Promise<T>;
  /** Establish definition stewardship through the public authority API, when bootstrap needs it. */
  authorizeDefinition(receipt: SeedLexiconReceipt): Promise<void>;
  /** Existing operator bootstrap preserves the identity and admitted role constraints. */
  currentDefinition?(key: string): Promise<(SeedLexiconReceipt & { state: DefinitionState }) | null>;
}

/** Per-bootstrap mapping consumed by relation migrations; namespace slashes stay inside the filename. */
export function relationLexiconSeedMapPath(namespace: string): string {
  return resolve('.temp/seed/relation-lexicon', `${encodeURIComponent(namespace)}.v3.json`);
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
  // Only this seed version's checkpoint permits label replay on a pre-existing
  // meaning. Earlier bootstraps already own their language slots and receipts.
  let checkpoint: typeof definitions = [];
  if (client.currentDefinition) {
    try {
      const saved = JSON.parse(await readFile(mappingFile, 'utf8')) as { labelReplays?: typeof definitions };
      checkpoint = saved.labelReplays ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const definition of data) {
    // Recording metadata changes the admitted digest; never reuse earlier seed receipts.
    const key = `${namespace}:lexicon:v3:${definition.key}`;
    const current = await client.currentDefinition?.(definition.key);
    if (current && current.state.lifecycle !== 'active') throw new Error('Bootstrap cannot reactivate a retired definition');
    const metadataMatches = current && (definition.editorRecordable === undefined && definition.writePath === undefined
      || (current.state.editorRecordable ?? false) === (definition.editorRecordable ?? false)
        && current.state.writePath === definition.writePath);
    // A metadata upgrade is a normal expected-head revision. Keep editor-authored
    // roles and the stable key; no graph maintenance write or identity replacement.
    if (current && !metadataMatches) await client.authorizeDefinition(current);
    const receipt = metadataMatches ? current : await client.post<SeedLexiconReceipt>(
      '/v1/semantic/changes',
      {
        profile: 'semantic-change-v1',
        actingSubject,
        expectedHead: current?.revision ?? null,
        ...(current ? { target: current.component } : {}),
        state: current ? { ...current.state,
          ...(definition.editorRecordable === undefined ? {} : { editorRecordable: definition.editorRecordable }),
          ...(definition.writePath === undefined ? {} : { writePath: definition.writePath }),
        } : {
          component: 'definition',
          kind: 'relation',
          notation: definition.key,
          ...(definition.editorRecordable === undefined ? {} : { editorRecordable: definition.editorRecordable }),
          ...(definition.writePath === undefined ? {} : { writePath: definition.writePath }),
          workSubjectRole: definition.roles.includes('work') ? 'work' : definition.roles[1],
          roles: definition.roles.map((role) => ({
            key: role,
            minParticipants: 1,
            maxParticipants: 1,
            ordered: false,
          })),
        },
      },
      `${key}:meaning${current ? `:${current.revision.split('/').at(-1)}` : ''}`,
    );
    const resumeLabels = !metadataMatches || checkpoint.some(item => item.key === definition.key
      && item.component === receipt.component && item.revision === receipt.revision);
    if (resumeLabels) checkpoint = [...checkpoint.filter(item => item.key !== definition.key),
      { key: definition.key, component: receipt.component, revision: receipt.revision }];
    definitions.push({
      key: definition.key,
      component: receipt.component,
      revision: receipt.revision,
    });
    // Checkpoint IDs before labels or authorization can fail; retries recover the same API receipts.
    await mkdir(dirname(mappingFile), { recursive: true });
    await writeFile(
      `${mappingFile}.tmp`,
      `${JSON.stringify({ profile: 'relation-lexicon-seed-map-v1', namespace, definitions,
        ...(client.currentDefinition ? { labelReplays: checkpoint } : {}) }, null, 2)}\n`,
    );
    await rename(`${mappingFile}.tmp`, mappingFile);
    if (!resumeLabels) continue;
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
          `${key}:${language}:${index}${client.currentDefinition ? `:${receipt.revision.split('/').at(-1)}` : ''}`,
        );
    }
  }
  return definitions;
}
