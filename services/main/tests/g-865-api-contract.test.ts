import { expect, test } from 'bun:test';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';

type Schema = { properties?: Record<string,Schema>; items?: Schema; anyOf?: Schema[]; const?: string; enum?: string[] };
type Operation = { security?: Array<Record<string,string[]>>; parameters?: Array<{ name: string; in: string; required: boolean }>;
  responses: Record<string,{ content: Record<string,{ schema: Schema }> }> };

test('G865: generated API exposes the common lifecycle, optional public reads and typed recovery blockers', async () => {
  const document = JSON.parse(await buildMainOpenApi()) as { paths: Record<string,Record<string,Operation>> };
  const root = '/v1/editorial/proposals';
  const writes = [root,...['revisions','reviews','decisions','withdrawal','reversal'].map(suffix => `${root}/{proposal}/${suffix}`)];
  for (const path of writes) {
    const operation = document.paths[path]!.post!;
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key',in: 'header',required: true }));
    const problem = operation.responses['409']!.content['application/problem+json']!.schema;
    expect(problem.properties?.blocker?.anyOf?.some(schema => schema.properties?.code?.const === 'stale_base')).toBe(true);
  }
  const read = document.paths[`${root}/{proposal}`]!.get!;
  expect(read.security).toEqual([{}, { bearerAuth: [] }]);
  const result = read.responses['200']!.content['application/json']!.schema;
  const actions = result.properties?.allowedActions?.items;
  expect(actions?.enum?.includes('recover') ?? actions?.anyOf?.some(action => action.const === 'recover')).toBe(true);
  expect(result.properties?.staleApprovalIdsComplete).toBeDefined();
  const blockers = result.properties?.blockers?.items?.anyOf ?? [];
  for (const code of ['owner_authority_required','owner_command_refused']) {
    expect(blockers.some(schema => schema.properties?.code?.const === code)).toBe(true);
  }
  const recovery = document.paths[`${root}/{proposal}/recovery`]!.post!;
  expect(recovery.security).toEqual([{}, { bearerAuth: [] }]);
  expect(recovery.parameters?.some(parameter => parameter.name === 'Idempotency-Key') ?? false).toBe(false);
  expect(recovery.responses['202']).toBeDefined();
});
