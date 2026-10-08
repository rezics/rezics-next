import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { StructureProgressStore } from '../src/modules/progress/store.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { COMPOSITION_PROFILE } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { RV } from '../src/modules/work/activate.ts';

/** One completion the production progress owner can resume. */
export interface ResumeCompletion {
  issuer: string;
  subject: string;
  structure: string;
  revision: string;
  occurrence: string;
  orderKey: string;
}

/** `new StructureProgressStore(contentPool)`, with the content tables these
 * fixtures can record into. Resume reads those rows through the owner. */
export function readingResumeOwner(rows: ResumeCompletion[]) {
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('structure.progress_reader')) {
      const hit = rows.some(row => row.issuer === values[0] && row.subject === values[1]);
      return { rows: hit ? [{ version: '1' }] : [] };
    }
    if (sql.includes('FROM structure.progress_scope') && sql.includes('order_revision')) {
      const hit = rows.find(row => row.issuer === values[0] && row.subject === values[1] && row.structure === values[2]);
      return { rows: hit ? [{ order_revision: hit.revision, ready: true }] : [] };
    }
    if (sql.includes('order_key DESC')) {
      const [issuer, subject, structure, revision, limit] = values;
      let matched = rows.filter(row => row.issuer === issuer && row.subject === subject
        && row.structure === structure && row.revision === revision);
      if (values.length > 5) {
        const key = String(values[5]), occurrence = String(values[6]);
        matched = matched.filter(row => row.orderKey < key || row.orderKey === key && row.occurrence < occurrence);
      }
      matched.sort((a, b) => a.orderKey < b.orderKey ? 1 : a.orderKey > b.orderKey ? -1
        : a.occurrence < b.occurrence ? 1 : a.occurrence > b.occurrence ? -1 : 0);
      return { rows: matched.slice(0, Number(limit)).map(row => ({
        occurrence: row.occurrence, selection_key: '', completed: true, position: null,
        version: '1', order_key: row.orderKey,
      })) };
    }
    return { rows: [] };
  } } as unknown as Pool;
  return new StructureProgressStore(pool);
}

export interface ResumeChapter { occurrence: string; segmentKey: string; orderKey: string; parent?: string }

/** A book whose chapters disclosure can see, so a recorded completion resolves. */
export function bookResumeEnvironment(input: {
  work: string; structure: string; revision: string; generation: string; chapters: readonly ResumeChapter[];
}) {
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async body => {
      const digest = createHash('sha256').update(body).digest('hex');
      stored.set(digest, body); return digest;
    },
    get: async digest => {
      const body = stored.get(digest);
      if (!body) throw new ObjectUnavailable('missing order object');
      return body;
    },
  };
  const component = `https://rezics.com/id/${randomUUID()}`;
  let count = 0, manifest = '';
  const ready = (async () => {
    const cost = newCost();
    const records = input.chapters.map((chapter): OccurrenceRecord => ({
      occurrence: chapter.occurrence, state: 'active', parent: chapter.parent ?? input.structure,
      segmentKey: chapter.segmentKey, orderKey: chapter.orderKey, role: 'chapter',
      target: 'https://schema.org/DigitalDocument', labels: [], introducedBy: input.revision,
    }));
    const recordRoot = records.length
      ? await recordTree(objects).apply(await recordTree(objects).empty(cost),
        new Map(records.map(record => [record.occurrence, record])), cost)
      : await recordTree(objects).empty(cost);
    const order = await orderTree(objects).empty(cost);
    const body = { format: STRUCTURE_MANIFEST_FORMAT, structure: input.structure, structureOf: component,
      profile: 'book-composition' as const, generation: input.generation, pageFormat: STRUCTURE_PAGE_FORMAT,
      records: recordRoot, order, placementCount: recordRoot.count, measures: [],
      model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
    count = body.placementCount;
    manifest = `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(body)))}`;
  })();
  const binding = (value: string) => ({ type: 'literal' as const, value });
  return { environment: { structureObjects: objects, fuseki: { query: async (sparql: string) => {
    await ready;
    if (sparql.includes('rv:structureHead') && sparql.includes('rv:placementCount')) return { results: { bindings: [{
      component: binding(component), profile: binding(`${RV}BookComposition`), head: binding(input.revision),
      generation: binding(input.generation), count: binding(String(count)), manifest: binding(manifest),
    }] } };
    if (sparql.includes('SELECT ?owner')) return { results: { bindings: [{ owner: binding(input.work) }] } };
    return { results: { bindings: [] } };
  } } } };
}
