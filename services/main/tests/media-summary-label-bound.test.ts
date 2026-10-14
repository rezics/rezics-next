import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resourceSummaryGraphQuery } from '../src/modules/media/summary.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('native summary resources match the production emitter and its unbounded counterfactual', () => {
  const bounded = resourceSummaryGraphQuery([id(1)]);
  const start = bounded.indexOf('OPTIONAL { FILTER(?type IN ("agent","zone"))');
  const end = bounded.indexOf('OPTIONAL { FILTER(?type = "agent")', start);
  const labels = bounded.slice(start, end);
  expect(labels.match(/VALUES \?r \{/g)).toHaveLength(2);
  const baseline = bounded.slice(0, start) + labels.replace(/VALUES \?r \{[^}]*\} /g, '') + bounded.slice(end);
  expect(readFileSync(new URL('../src/modules/query/templates/media-summary.rq', import.meta.url), 'utf8'))
    .toBe(`${bounded}\n`);
  const fixtures = new URL('../../../infra/jena/command-module/src/test/resources/media-summary/', import.meta.url);
  expect(readFileSync(new URL('baseline.rq', fixtures), 'utf8')).toBe(`${baseline}\n`);
  expect(readFileSync(new URL('semantics.rq', fixtures), 'utf8'))
    .toBe(`${resourceSummaryGraphQuery([1, 10, 11, 12, 13, 20, 21, 22].map(id))}\n`);
});

test('each independent agent/Zone label input is anchored to the requested batch', () => {
  for (const resources of [[], [id(1)], [id(1), id(2), id(3)]]) {
    for (const proveAbsence of [false, true]) {
      const query = resourceSummaryGraphQuery(resources, proveAbsence);
      const labels = query.slice(query.indexOf('OPTIONAL { FILTER(?type IN ("agent","zone"))'),
        query.indexOf('OPTIONAL { FILTER(?type = "agent")'));
      const values = `VALUES ?r { ${resources.map(resource => `<${resource}>`).join(' ')} }`;
      // An outer VALUES only constrains the left join's left input. Both
      // independent UNION branches must carry their own finite input relation.
      expect(labels).toContain(`{ ${values} ?r rdfs:label ?label }`);
      expect(labels).toContain(`UNION { ${values} ?r a rv:Zone ; rv:space ?zoneSpace .`);
      expect(labels).toContain('FILTER NOT EXISTS { ?r rdfs:label ?zoneLabel }');
      expect(labels).toContain('?zoneSpace rdfs:label ?label');
    }
  }
});
