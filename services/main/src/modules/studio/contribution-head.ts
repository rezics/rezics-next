import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';

export interface ContributionHead {
  contribution: string;
  work: string;
  language: string;
  author: string;
  draftHead: string;
  publicationHead: string | null;
}

/** One bounded current-head lookup. The route checks current Access authority first. */
export async function readContributionHead(env: WorkActivationEnvironment,
  contribution: string): Promise<ContributionHead | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> SELECT ?work ?language ?author ?draft ?publication WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(contribution)} a rv:TextContribution ; rv:work ?work ; rv:author ?author ;
          rv:language ?language ; rv:draftHead ?draft .
        ?work a schema:CreativeWork .
        OPTIONAL { ${iri(contribution)} rv:publicationHead ?publication }
      }
    } LIMIT 2`)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.language || !rows[0]?.author
    || !rows[0]?.draft) throw new Error('Contribution current head is ambiguous');
  const row = rows[0];
  return { contribution, work: row.work.value, language: row.language.value,
    author: row.author.value, draftHead: row.draft.value,
    publicationHead: row.publication?.value ?? null };
}
