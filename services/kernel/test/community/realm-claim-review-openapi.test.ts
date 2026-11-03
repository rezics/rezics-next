import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { kernelContract } from '../../scripts/openapi.ts';

type Schema = {
  type?: string | string[];
  format?: string;
  const?: unknown;
  enum?: unknown[];
  nullable?: boolean;
  maxLength?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
};

type Operation = {
  operationId?: string;
  parameters?: { in: string; name: string; required?: boolean; schema?: Schema }[];
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  'x-action'?: string;
  'x-exposure'?: string;
  'x-resource-types'?: string[];
};

function alternatives(schema: Schema): Schema[] {
  const options = schema.oneOf ?? schema.anyOf ?? [schema];
  return options.filter((option) => {
    if (option.type === 'null') return false;
    if (option.properties) return true;
    return !(Array.isArray(option.type) && option.type.includes('null'));
  });
}

function literal(schema: Schema | undefined): unknown {
  return schema?.const ?? schema?.enum?.[0];
}

function properties(schema: Schema | undefined): Record<string, Schema> {
  return schema?.properties ?? {};
}

function hasNull(schema: Schema | undefined): boolean {
  if (!schema) return false;
  return (
    schema.nullable === true ||
    (Array.isArray(schema.type) && schema.type.includes('null')) ||
    [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some(
      (option) => option.type === 'null' || (Array.isArray(option.type) && option.type.includes('null')),
    )
  );
}

test('Kernel publishes bounded and authority-aware Realm claim review contracts', async () => {
  const generated = await kernelContract();
  const output = resolve(import.meta.dir, '../../../../.temp/claim-review-openapi.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, generated);

  const document = JSON.parse(generated) as {
    paths?: Record<string, { get?: Operation }>;
  };
  const get = (path: string): Operation => {
    const operation = document.paths?.[path]?.get;
    expect(operation).toBeDefined();
    return operation!;
  };
  const response = (operation: Operation): Schema => {
    const schema = operation.responses?.['200']?.content?.['application/json']?.schema;
    expect(schema).toBeDefined();
    return schema!;
  };

  const review = get('/v1/realms/{realmId}/claimRequests');
  expect(review.operationId).toBe('realm.claim_requests');
  expect(review).toMatchObject({ 'x-action': 'realm:approve_claim', 'x-exposure': 'public' });
  const cursor = review.parameters?.find(({ in: location, name }) => location === 'query' && name === 'cursor');
  expect(cursor).toMatchObject({ required: false, schema: { type: 'string', maxLength: 4096 } });
  const inspect = review.parameters?.find(
    ({ in: location, name }) => location === 'query' && name === 'inspectRequestId',
  );
  expect(inspect).toMatchObject({ required: false, schema: { type: 'string', format: 'uuid' } });

  const reviewBody = properties(response(review));
  const request = properties(reviewBody.claimRequests?.items);
  expect(reviewBody.claimRequests?.type).toBe('array');
  expect(reviewBody.claimRequests?.items?.required).toEqual(
    expect.arrayContaining(['claimant', 'approvalAdvice']),
  );
  expect(Object.keys(properties(request.claimant)).sort()).toEqual(['href', 'label']);
  expect(Object.keys(properties(request.approvalAdvice)).sort()).toEqual([
    'destination',
    'method',
    'requiredAction',
    'requiredHeader',
  ]);
  expect(literal(properties(request.approvalAdvice).method)).toBe('POST');
  expect(literal(properties(request.approvalAdvice).requiredAction)).toBe('realm:approve_claim');
  expect(literal(properties(request.approvalAdvice).requiredHeader)).toBe('Idempotency-Key');

  const selected = reviewBody.selectedRequest;
  expect(hasNull(selected)).toBe(true);
  const selectedStates = alternatives(selected!).map((variant) => literal(properties(variant).state));
  expect(selectedStates).toEqual(expect.arrayContaining(['pending', 'approved']));
  const approved = alternatives(selected!).find((variant) => literal(properties(variant).state) === 'approved');
  expect(approved).toBeDefined();
  expect(properties(approved!).currentEpisode).toMatchObject({ const: false });
  expect(properties(approved!).claimant).toBeUndefined();
  expect(properties(approved!).approvalAdvice).toBeUndefined();

  const realmPresentations = alternatives(reviewBody.realmPresentation!);
  expect(realmPresentations.map((variant) => literal(properties(variant).state))).toEqual(
    expect.arrayContaining(['available', 'unavailable']),
  );
  const availableRealm = realmPresentations.find((variant) => literal(properties(variant).state) === 'available');
  const unavailableRealm = realmPresentations.find((variant) => literal(properties(variant).state) === 'unavailable');
  expect(Object.keys(properties(availableRealm)).sort()).toEqual(['description', 'name', 'state']);
  expect(Object.keys(properties(unavailableRealm)).sort()).toEqual(['state']);
  expect(reviewBody.requestAdvice).toBeUndefined();

  for (const [path, operationId, nullable] of [
    ['/v1/realms/{realmId}/claimRequests/mine', 'realm.own_claim_request', true],
    ['/v1/realms/{realmId}/claimRequests/{requestId}', 'realm.claim_request_status', false],
  ] as const) {
    const claimant = get(path);
    expect(claimant.operationId).toBe(operationId);
    expect(claimant).toMatchObject({
      'x-action': 'realm:read',
      'x-exposure': 'public',
      'x-resource-types': ['community.realm'],
    });
    const requestId = claimant.parameters?.find(
      ({ in: location, name }) => location === 'path' && name === 'requestId',
    );
    if (path.endsWith('{requestId}')) expect(requestId).toMatchObject({ required: true });
    const body = properties(response(claimant));
    const ownRequest = body.claimRequest;
    expect(hasNull(ownRequest)).toBe(nullable);
    const ownRequestVariant = alternatives(ownRequest!)[0];
    expect(properties(ownRequestVariant).currentEpisode).toMatchObject({ type: 'boolean' });
    expect(properties(ownRequestVariant).claimant).toBeUndefined();
    expect(properties(ownRequestVariant).approvalAdvice).toBeUndefined();
    expect(Object.keys(properties(body.requestAdvice)).sort()).toEqual([
      'destination',
      'method',
      'requiredAction',
      'requiredHeader',
    ]);
    expect(literal(properties(body.requestAdvice).method)).toBe('POST');
    expect(literal(properties(body.requestAdvice).requiredAction)).toBe('realm:participate');
    expect(literal(properties(body.requestAdvice).requiredHeader)).toBe('Idempotency-Key');
  }
});
