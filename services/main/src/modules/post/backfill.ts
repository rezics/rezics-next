import type { Pool } from 'pg';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

export const POST_BACKFILL_COST = { batch: 24, graphReadsPerBatch: 2, mainTriples: 16,
  sqlReadsPerBatch: 1, graphCommandsPerBatch: 1, deadlineMs: 600_000 } as const;

type Term = NonNullable<SparqlResult['results']>['bindings'][number][string];
function rdfTerm(term: Term): string {
  if (term.type === 'uri') {
    if (/[\s<>"{}|\\^\x60]/.test(term.value)) throw new Error('Invalid legacy RDF IRI');
    return `<${term.value}>`;
  }
  if (term.type !== 'literal' && term.type !== 'typed-literal') throw new Error('Legacy blank nodes are unavailable');
  return `${lit(term.value)}${term['xml:lang'] ? `@${term['xml:lang']}` : term.datatype
    ? `^^${rdfTerm({ type: 'uri', value: term.datatype })}` : ''}`;
}

export interface LegacyChapter { post: string; main: string; head: string; publisher: string }

/** A conversion changes current identity only. All immutable histories and
 * resource-keyed owner rows remain intact, including legacy receipt proofs. */
export function planChapterPosts(rows: readonly LegacyChapter[]) {
  if (rows.length > POST_BACKFILL_COST.batch || new Set(rows.map(row => row.post)).size !== rows.length
    || rows.some(row => [row.post, row.main, row.head, row.publisher]
      .some(value => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value))
      || row.post === row.main || row.post === row.head)) {
    throw new Error('Legacy chapter identities are ambiguous');
  }
  return rows.map(row => ({ ...row }));
}

/** Before listening, repeatedly convert only the remaining legacy candidates.
 * Each bounded graph transaction is its own durable checkpoint: interruption
 * resumes at the remaining CreativeWorks, without scanning converted Posts. */
export async function prepareChapterPosts(env: WorkActivationEnvironment, access: Pick<Pool, 'query'>,
  options: { signal?: AbortSignal } = {}) {
  const deadline = Date.now() + POST_BACKFILL_COST.deadlineMs;
  let converted = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Post migration reached its ten-minute budget; restart to resume');
    const found = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> SELECT DISTINCT ?post ?main ?head ?book ?continuity WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?post a schema:CreativeWork ; schema:isPartOf ?book ; rv:mainVersion ?main ; rv:head ?head .
        OPTIONAL { ?post rv:continuityProfile ?continuity }
        ?main a rv:MainVersion ; rv:work ?post ; rv:hostingPolicy rv:MetadataOnly .
        ?book a schema:Book ; rv:mainVersion ?bookMain .
        ?structure a rv:Structure ; rv:structureProfile rv:BookComposition ;
          rv:structureOf ?bookMain ; rv:selectedGeneration ?generation .
        ?generation rv:generationState rv:Active .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?post .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      }
    } LIMIT ${POST_BACKFILL_COST.batch}`, 64 * 1024)).results?.bindings ?? [];
    if (!found.length) return converted;
    const publishers = (await access.query<{ post: string; publisher: string }>(`
      SELECT s.work AS post, a.acting_subject AS publisher FROM access.work_maintainer_set s
      JOIN access.admission a ON a.id = s.creation_admission
      WHERE s.work = ANY($1::text[]) AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'`,
    [found.map(row => row.post?.value)])).rows;
    const byPost = new Map(publishers.map(row => [row.post, row.publisher]));
    const rows = planChapterPosts(found.map(row => ({ post: row.post?.value ?? '', main: row.main?.value ?? '',
      head: row.head?.value ?? '', publisher: byPost.get(row.post?.value ?? '') ?? '' })));
    const mainTriples = (await env.fuseki.query(`SELECT ?main ?predicate ?value WHERE {
      VALUES ?main { ${rows.map(row => iri(row.main)).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?main ?predicate ?value }
    } LIMIT ${rows.length * POST_BACKFILL_COST.mainTriples + 1}`, 128 * 1024)).results?.bindings ?? [];
    const byMain = new Map(rows.map(row => [row.main, [] as typeof mainTriples]));
    for (const triple of mainTriples) {
      const inventory = byMain.get(triple.main?.value ?? '');
      if (!inventory || !triple.predicate || !triple.value) throw new Error('Legacy Main inventory is invalid');
      inventory.push(triple);
      if (inventory.length > POST_BACKFILL_COST.mainTriples) throw new Error('Legacy Main inventory exceeds batch budget');
    }
    const removed = rows.flatMap((row, index) => {
      const candidate = found[index]!;
      if (!candidate.book || !byMain.get(row.main)?.length) throw new Error('Legacy chapter owner is unavailable');
      return [`${iri(row.post)} a schema:CreativeWork ; rv:mainVersion ${iri(row.main)} ;
        schema:isPartOf ${iri(candidate.book.value)} .`,
      ...(candidate.continuity ? [`${iri(row.post)} rv:continuityProfile ${rdfTerm(candidate.continuity)} .`] : []),
      ...byMain.get(row.main)!.map(triple => `${iri(row.main)} ${rdfTerm(triple.predicate!)} ${rdfTerm(triple.value!)} .`)];
    });
    const digest = hash(JSON.stringify({ family: 'chapter-post-backfill-v1', epoch: env.lineage.dataEpoch, rows, removed }));
    const receipt = `urn:rezics:receipt:chapter-post-backfill:${digest}`;
    const validations = (await Promise.all(rows.map(row => profileValidations(env.fuseki, 'post-v1', [{
      shape: 'https://rezics.com/definition/post-v1/post-shape', focus: [row.post], graphs: [GRAPHS.current],
    }], { post: row.post, publisher: row.publisher, revision: row.head })))).flat();
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations, deadlineMs: 60_000,
      update: `PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
          GRAPH ${iri(GRAPHS.current)} {
            ${removed.join('\n')}
          } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${rows.map(row => `${iri(row.post)} a rv:Post ; rv:publisher ${iri(row.publisher)} .`).join('\n')} }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
            rv:outcome rv:Succeeded ; rv:action "post.migrate" ;
            rv:migratedPost ${rows.map(row => iri(row.post)).join(', ')} ;
            rv:migratedPostCount ${rows.length} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${digest}`)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
            rv:event ${iri(`urn:rezics:event:${digest}`)} .
            ${iri(`urn:rezics:event:${digest}`)} a rv:PostsMigratedEvent ; rv:ordinal 0 ;
              rv:action "post.migrate" ; rv:receipt ${iri(receipt)} . }
        } WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          ${rows.map(row => `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
            ${iri(row.post)} a schema:CreativeWork ; rv:mainVersion ${iri(row.main)} ; rv:head ${iri(row.head)} .
            ${iri(row.main)} rv:hostingPolicy rv:MetadataOnly . } }`).join('\n')}
          ${rows.map(row => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
            ${iri(row.main)} ?unexpectedPredicate ?unexpectedValue .
            FILTER NOT EXISTS {
              VALUES (?expectedPredicate ?expectedValue) {
                ${byMain.get(row.main)!.map(triple => `(${rdfTerm(triple.predicate!)} ${rdfTerm(triple.value!)})`).join(' ')}
              }
              FILTER(?unexpectedPredicate = ?expectedPredicate && ?unexpectedValue = ?expectedValue)
            }
          } }`).join('\n')}
          BIND(?n + 1 AS ?next)
        }` });
    if (result.status !== 'committed') throw new Error(`Post migration did not commit: ${result.status}${result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''}`);
    converted += rows.length;
  }
}
