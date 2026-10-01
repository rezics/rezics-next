import { expect, test } from 'bun:test';
import type { MainApp } from '../src/app.ts';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';

type Routes = MainApp['~Routes']['v1'];
type Assert<Condition extends true> = Condition;
type _Admission = Assert<Routes['works']['post']['response'][201] extends { admissionId: string } ? true : false>;
type _Review = Assert<Routes['realm-reply-placements']['post']['response'][201] extends {
  reviewDecisionId: string; reviewGeneration: string
} ? true : false>;
type _Authority = Assert<Routes['access']['authority-state']['get']['response'][200] extends {
  authorityEpoch: string; representation: { id: string; generation: string }
} ? true : false>;

test('G-903 generated contracts carry every next-call precondition', async () => {
  const document = JSON.parse(await buildMainOpenApi()) as { paths: Record<string, Record<string, {
    security?: unknown[]; responses: Record<string, { content: Record<string, { schema: {
      required: string[]; properties: Record<string, any>
    } }> }>
  }>> };
  const schema = (path: string, method: string, status: string) =>
    document.paths[path]![method]!.responses[status]!.content['application/json']!.schema;
  for (const status of ['200', '201']) {
    const work = schema('/v1/works', 'post', status) as { required?: string[]; anyOf?: { required?: string[] }[] };
    expect(work.required ?? work.anyOf?.find(branch => branch.required?.includes('work'))?.required).toContain('admissionId');
    expect(schema('/v1/realm-reply-placements', 'post', status).required).toContain('reviewGeneration');
  }
  for (const path of ['/v1/access/authority-state', '/v1/access/revocation-sources/{sourceId}']) {
    expect(document.paths[path]!.get!.security?.length).toBeGreaterThan(0);
    expect(schema(path, 'get', '200').required).toContain('authorityEpoch');
  }
  const items = schema('/v1/me/notifications', 'get', '200').properties.items.items;
  expect(items.required).toContain('deliveries');
  expect(items.properties.deliveries.maxItems).toBe(8);
});
