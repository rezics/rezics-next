import { SemanticChangeRejected } from '../semantic/command.ts';
import { readExactDefinition, type ExactDefinition } from '../relation/change.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor } from '../work/read-session.ts';
import { RevisionCorrupt } from '../work/history.ts';
import type { ReferenceDisclosure } from '../target/disclosed-references.ts';
import { checkedDefinitionKey, KEY_NOTATION } from './definition-key.ts';

export const DEFINITION_LIST_LIMIT = 64;
export interface DefinitionListOptions {
  limit: number;
  recordable?: boolean;
  cursor?: string;
  languages: readonly string[];
}

/** Live keyset read: one index page (limit + 1, <= 65 rows / 32 KiB), at most
 * limit exact manifests. Access fences each current revision before object reads.
 * Rendering adds only the existing per-meaning language inventory/selected-object
 * cost. No resource inventory scan or OFFSET; hidden/nonrecordable candidates may
 * yield a short or empty page with a continuation. Cursors hide even private keys,
 * bind the selection and epoch, expire on restart/after 15 minutes, and grant no rights.
 */
export async function listDefinitions(
  env: WorkActivationEnvironment,
  options: DefinitionListOptions,
  publicRead: (definition: string, revision: string) => Promise<boolean>,
  disclose: ReferenceDisclosure,
): Promise<{ items: ExactDefinition[]; next: string | null }> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > DEFINITION_LIST_LIMIT
  ) {
    throw new SemanticChangeRejected('invalid', 'definition list limit is invalid');
  }
  const binding = {
    profile: 'relation-definition-list-v1',
    limit: options.limit,
    recordable: options.recordable ?? null,
    languages: options.languages,
  };
  // This is a live catalog, not a graph snapshot. Recheck disclosure on every page.
  const position = { dataEpoch: env.lineage.dataEpoch, sequence: 'lexicon-live-v1' };
  const cursor = decodeReadCursor(options.cursor, binding, position);
  const after = cursor ? checkedDefinitionKey(cursor.after) : null;
  const result = await env.fuseki.query(
    `PREFIX rv: <${RV}> SELECT ?key ?definition ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?entry a rv:DefinitionKey ; rv:keyDefinition ?definition ;
      <${KEY_NOTATION}> ?key . ?definition a rv:SemanticDefinition ;
      rv:definitionKind rv:RelationDefinition ; rv:definitionHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision, rv:RevisionAnchor ;
      rv:component ?definition ; rv:lifecycle rv:Active ; rv:sequence ?sequence }
    ${after ? `FILTER(STR(?key) > ${lit(after)})` : ''}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?definition rv:protectionHead ?protection } }
  } ORDER BY ?key LIMIT ${options.limit + 1}`,
    32_768,
  );
  const rows = result.results?.bindings ?? [];
  const keys = rows.map((row) => checkedDefinitionKey(row.key?.value));
  if (
    rows.length > options.limit + 1 ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key, index) => (index > 0 && key <= keys[index - 1]!) || (after !== null && key <= after),
    )
  ) {
    throw new RevisionCorrupt('definition catalog keys are ambiguous or unordered');
  }
  const items: ExactDefinition[] = [];
  for (const [index, row] of rows.slice(0, options.limit).entries()) {
    const definition = row.definition?.value,
      revision = row.head?.value;
    if (!definition || !revision)
      throw new RevisionCorrupt('definition catalog entry is incomplete');
    if (!(await publicRead(definition, revision))) continue;
    const meaning = await readExactDefinition(env, revision, disclose); // `publicRead` above already gated the definition
    if (!meaning || meaning.definition !== definition || meaning.notation !== keys[index]) {
      throw new RevisionCorrupt('definition catalog differs from its retained meaning');
    }
    if (
      meaning.lifecycle !== 'active' ||
      (options.recordable !== undefined &&
        (meaning.editorRecordable ?? false) !== options.recordable)
    )
      continue;
    items.push(meaning);
  }
  return {
    items,
    next:
      rows.length > options.limit
        ? encodeReadCursor(binding, position, keys[options.limit - 1]!, '', Date.now() + 900_000)
        : null,
  };
}
