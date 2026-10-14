import { expect, test } from 'bun:test';
import { resourceSummaryGraphQuery } from '../src/modules/media/summary.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
