import { relationLexiconSeed, variantKindConcepts, canonicityConcepts, workFormatConcepts,
  declaredCountProperties, type LexiconSeedDefinition, type WorkFormatKey } from './relation-lexicon-data.ts';
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
  /** Concept IRIs by `variantKindConcepts` key. Without them a definition's `roleMembers` stay unenforced. */
  concepts?: Readonly<Record<string, string>>,
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
  const membersOf = (definition: LexiconSeedDefinition, role: string): string[] | undefined => {
    const keys = definition.roleMembers?.[role];
    return keys && concepts && keys.every(key => concepts[key])
      ? keys.map(key => concepts[key]!).sort() : undefined;
  };
  for (const definition of data) {
    // Recording metadata changes the admitted digest; never reuse earlier seed receipts.
    const key = `${namespace}:lexicon:v3:${definition.key}`;
    const current = await client.currentDefinition?.(definition.key);
    if (current && current.state.lifecycle !== 'active') throw new Error('Bootstrap cannot reactivate a retired definition');
    const membersMatch = !current || current.state.roles.every(role => {
      const expected = membersOf(definition, role.key);
      return !expected || JSON.stringify(role.members ?? null) === JSON.stringify(expected);
    });
    const metadataMatches = current && membersMatch && (definition.editorRecordable === undefined && definition.writePath === undefined
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
          roles: current.state.roles.map(role => membersOf(definition, role.key)
            ? { ...role, members: membersOf(definition, role.key) } : role),
          ...(definition.editorRecordable === undefined ? {} : { editorRecordable: definition.editorRecordable }),
          ...(definition.writePath === undefined ? {} : { writePath: definition.writePath }),
        } : {
          component: 'definition',
          kind: 'relation',
          notation: definition.key,
          ...(definition.editorRecordable === undefined ? {} : { editorRecordable: definition.editorRecordable }),
          ...(definition.writePath === undefined ? {} : { writePath: definition.writePath }),
          ...(definition.workAuthority === false ? {}
            : { workSubjectRole: definition.roles.includes('work') ? 'work' : definition.roles[1] }),
          ...(definition.star ? { star: definition.star } : {}),
          roles: [...definition.roles, ...definition.extraRoles ?? []].map((role) => ({
            key: role,
            minParticipants: 1,
            maxParticipants: 1,
            ordered: false,
            ...(membersOf(definition, role) ? { members: membersOf(definition, role) } : {}),
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

/**
 * Create the Concepts the `kind` role of `variant-of` refers to, in one scheme through the public
 * vocabulary API. A replay under the same namespace returns the same Concepts.
 */
export async function seedVariantKindConcepts(
  client: Pick<SeedLexiconClient, 'post'>,
  actingSubject: string,
  namespace: string,
): Promise<Record<(typeof variantKindConcepts)[number]['key'], string>> {
  const concepts: Record<string, string> = {};
  let scheme: { id: string; expectedHead: string } | null = null;
  for (const kind of variantKindConcepts) {
    const created: { scheme: string; schemeHead: string; concept: string } = await client.post(
      '/v1/classification-vocabulary',
      { profile: 'classification-proposition-v2', scheme, labels: kind.labels, alternativeLabels: [],
        broader: [], narrower: [], actingSubject },
      `${namespace}:variant-kind:v1:${kind.key}`,
    );
    concepts[kind.key] = created.concept;
    scheme = { id: created.scheme, expectedHead: created.schemeHead };
  }
  return concepts as Record<(typeof variantKindConcepts)[number]['key'], string>;
}

/** Public vocabulary writes retain one canonicity scheme and a property DefinitionRef.
 * A Statement names a Concept as its value, the continuity as applicability and
 * its authority as speaker; Context acceptance decides which speakers count. */
export async function seedCanonicity(client: Pick<SeedLexiconClient, 'post' | 'authorizeDefinition'>,
  actingSubject: string, namespace: string) {
  const concepts: Record<string, string> = {};
  let scheme: { id: string; expectedHead: string } | null = null;
  for (const concept of canonicityConcepts) {
    const created: { scheme: string; schemeHead: string; concept: string } = await client.post(
      '/v1/classification-vocabulary',
      { profile: 'classification-proposition-v2', scheme, labels: concept.labels, alternativeLabels: [],
        broader: [], narrower: [], actingSubject }, `${namespace}:canonicity:v1:${concept.key}`);
    concepts[concept.key] = created.concept;
    scheme = { id: created.scheme, expectedHead: created.schemeHead };
  }
  const definition = await client.post<SeedLexiconReceipt>('/v1/semantic/changes',
    { profile: 'semantic-change-v1', actingSubject, expectedHead: null,
      state: { component: 'definition', kind: 'property', notation: 'canonicity', roles: [] } },
    `${namespace}:canonicity:v1:property`);
  await client.authorizeDefinition(definition);
  return { definition, scheme: scheme!.id,
    concepts: concepts as Record<(typeof canonicityConcepts)[number]['key'], string> };
}

export interface WorkFormatConceptSeed { concept: string; definitionRevision: string }
export interface WorkFormatSeed {
  scheme: string;
  concepts: Record<WorkFormatKey, WorkFormatConceptSeed>;
  counts: Record<(typeof declaredCountProperties)[number]['notation'], SeedLexiconReceipt>;
}

/**
 * One format scheme and the two declared-count properties, shared by bootstrap and import.
 * Keys stay fixed: a notation is unique, and a second key would register a second property.
 * The scheme cannot say "at most one concept"; the importer admits a single format.
 */
export async function seedWorkFormat(client: Pick<SeedLexiconClient, 'post' | 'authorizeDefinition'>,
  actingSubject: string): Promise<WorkFormatSeed> {
  const concepts = {} as WorkFormatSeed['concepts'];
  let scheme: { id: string; expectedHead: string } | null = null;
  for (const concept of workFormatConcepts) {
    const created: { scheme: string; schemeHead: string; concept: string; definitionRevision: string } =
      await client.post('/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme, labels: [...concept.labels], alternativeLabels: [],
      broader: [], narrower: [], actingSubject }, `work-format:v1:concept:${concept.key}`);
    concepts[concept.key] = { concept: created.concept, definitionRevision: created.definitionRevision };
    scheme = { id: created.scheme, expectedHead: created.schemeHead };
  }
  const counts = {} as WorkFormatSeed['counts'];
  for (const property of declaredCountProperties) {
    const definition = await client.post<SeedLexiconReceipt>('/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject, expectedHead: null,
      state: { component: 'definition', kind: 'property', notation: property.notation, roles: [] } },
    `work-format:v1:property:${property.notation}`);
    await client.authorizeDefinition(definition);
    counts[property.notation] = definition;
  }
  return { scheme: scheme!.id, concepts, counts };
}
