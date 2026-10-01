import { expect, test } from 'bun:test';
import type { MainApp } from '../src/app.ts';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';

type DraftResponse = MainApp['~Routes']['v1']['member-reply-drafts']['post']['response'];
type Assert<Condition extends true> = Condition;
type _CreatedDigest = Assert<DraftResponse[201] extends { revisionDigest: string } ? true : false>;
type _ReplayedDigest = Assert<DraftResponse[200] extends { revisionDigest: string } ? true : false>;

test('G-902 generated draft success contracts require the digest used for placement', async () => {
  const document = JSON.parse(await buildMainOpenApi()) as {
    paths: Record<string, { post: { responses: Record<string, {
      content: Record<string, { schema: { required: string[]; properties: Record<string, unknown> } }>;
    }> } }>;
  };
  const responses = document.paths['/v1/member-reply-drafts']!.post.responses;
  for (const status of ['200', '201']) {
    const schema = responses[status]!.content['application/json']!.schema;
    expect(schema.required).toContain('revisionDigest');
    expect(schema.properties.revisionDigest).toEqual({ type: 'string', pattern: '^[0-9a-f]{64}$' });
  }
});
