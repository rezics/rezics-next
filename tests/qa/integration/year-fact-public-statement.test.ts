import { expect, test } from 'bun:test';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { DATE_PUBLISHED_DEFINITION_NOTATION, DATE_PUBLISHED_PREDICATE } from '../../../services/main/src/modules/statement/qualification.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

const QUERY = 'https://rezics.com/query/work-publication-years';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const short = (ref: string) => ref.slice(-36);

test('a public first-publication Statement is listed by work-publication-years and leaves when withdrawn', async () => {
  const stack = await startMediaStack('year-fact-public-statement');
  try {
    const member = await stack.member('year-publisher');
    await ensureGlobalClassificationContext(stack.env);
    const dated = await stack.publicWork(member.actor);
    const undated = await stack.publicWork(member.actor);
    await member.grant('semantic:create:root', 'semantic.change');
    await member.grant(`statement:speak:${member.actor}`, 'statement.record');
    await member.grant(`statement:speak:${member.actor}`, 'statement.withdraw');
    await member.grant('classification:decide:global', 'statement.decide');
    await member.grant(`work:read:${dated.work}`, 'work.read');
    await member.grant(`work:read:${undated.work}`, 'work.read');
    const defined = await member.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: member.actor,
      state: { component: 'definition', kind: 'property', lifecycle: 'active', successor: null, roles: [],
        notation: DATE_PUBLISHED_DEFINITION_NOTATION },
    });
    const definedText = await defined.text();
    if (defined.status !== 201 && defined.status !== 200) throw new Error(`${defined.status}: ${definedText}`);
    const property = JSON.parse(definedText) as { component: string; revision: string };
    await member.grant(`semantic:read:${property.component}`, 'semantic.read');
    const statementBody = (lexical: string, datatype: string) => ({
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: dated.work,
      predicate: property.component, relationDefinition: property.revision,
      value: { kind: 'literal', lexical, datatype, language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: member.actor,
    });
    const refused = await member.send('POST', '/v1/statements', statementBody('1980', `${XSD}string`));
    const refusedBody = await refused.json() as { code?: string };
    expect(refused.status).toBe(400);
    expect(refusedBody.code).toBe('invalid_request');
    const written = await member.send('POST', '/v1/statements', statementBody('1980-01-01', `${XSD}date`));
    const writtenText = await written.text();
    if (written.status !== 201) throw new Error(`${written.status}: ${writtenText}`);
    const statement = JSON.parse(writtenText) as { statement: string; revision: string };
    const stored = await stack.fuseki.query(`PREFIX rdf: <${RDF}> PREFIX rv: <${RV}>
      ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(statement.statement)} rdf:predicate <${DATE_PUBLISHED_PREDICATE}> ;
          rv:relationDefinition ${iri(property.revision)} .
      } }`);
    expect(stored.boolean).toBe(true);
    const read = await member.read(`/v1/statements/${short(statement.statement)}`);
    const readText = await read.text();
    if (read.status !== 200) throw new Error(`${read.status}: ${readText}`);
    const resource = JSON.parse(readText) as { predicate: string; relationDefinition: string; revision: string };
    expect(resource.predicate).toBe(property.component);
    expect(resource.relationDefinition).toBe(property.revision);
    const decision = await member.send('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted',
      actingSubject: member.actor,
    });
    const decisionText = await decision.text();
    if (decision.status !== 201 && decision.status !== 200) throw new Error(`${decision.status}: ${decisionText}`);
    const query = async () => {
      const response = await stack.main.handle(new Request('http://main.local/v1/query', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'template-query-v1', query: QUERY, revision: 1, parameters: {} }) }));
      const value = await response.json() as { result?: { items: Array<{ id: string; year: number; statement: string }> } };
      if (response.status !== 200) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
      return value.result!.items;
    };
    const listed = await query();
    expect(listed.map(item => ({ id: item.id, year: item.year, statement: item.statement }))).toEqual([
      { id: dated.work, year: 1980, statement: statement.statement },
    ]);
    expect(listed.map(item => item.id)).not.toContain(undated.work);
    // The API withdraws a Statement; it has no separate supersede operation.
    const withdrawn = await member.send('POST', `/v1/statements/${short(statement.statement)}/withdrawals`, {
      profile: 'statement-v1', speaker: { kind: 'personal' }, expectedHead: resource.revision,
      actingSubject: member.actor,
    });
    const withdrawnText = await withdrawn.text();
    if (withdrawn.status !== 201 && withdrawn.status !== 200) throw new Error(`${withdrawn.status}: ${withdrawnText}`);
    const after = await query();
    expect(after.map(item => item.id)).not.toContain(dated.work);
    expect(after.map(item => item.id)).not.toContain(undated.work);
  } finally {
    await stack.stop();
  }
}, 180_000);
