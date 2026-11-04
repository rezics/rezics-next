import type {
  OperationCatalogue,
  OperationDescriptor,
  OperationMethod,
  OperationRateLimit,
} from '@rezics/operations';
import type { TSchema } from 'typebox';
import { defineRateLimit, type RateLimitDeclaration } from './rate-limit.ts';

type SchemaBinding<Schema> = Readonly<{ reference: string; schema: Schema }>;

export type OperationSchemaBindings = Readonly<{
  params?: SchemaBinding<TSchema>;
  query?: SchemaBinding<TSchema>;
  headers?: SchemaBinding<TSchema>;
  body?: SchemaBinding<TSchema>;
  response: SchemaBinding<Readonly<Record<number, TSchema>>>;
}>;

const rateLimits: Readonly<Record<OperationRateLimit, RateLimitDeclaration>> = Object.freeze({
  'kernel.write.single': defineRateLimit({ family: 'write', units: 1 }),
  'kernel.write.commands': defineRateLimit({ family: 'write', units: 'commands' }),
  'kernel.provider.single': defineRateLimit({ family: 'provider', units: 1 }),
});

function operationDetail(descriptor: OperationDescriptor) {
  const security = descriptor.security.map(({ scheme }) =>
    scheme === 'anonymous' ? {} : { bearerAuth: [] },
  );
  return {
    operationId: descriptor.operationId,
    'x-action': descriptor.action,
    'x-exposure': descriptor.exposure,
    security,
    ...(descriptor.resourceTypes.length === 0 ? {} : { 'x-resource-types': descriptor.resourceTypes }),
    ...(descriptor.replayAuthorization === undefined
      ? {}
      : { 'x-replay-authorization': descriptor.replayAuthorization }),
    ...(descriptor.authority === undefined
      ? {}
      : {
          'x-authority-anchor': descriptor.authority.anchor,
          'x-authority-resource-types': descriptor.authority.resourceTypes,
        }),
    ...(descriptor.rateLimit === undefined ? {} : { 'x-rate-limit': rateLimits[descriptor.rateLimit] }),
  };
}

function requireSchemaReference(
  descriptor: OperationDescriptor,
  slot: 'params' | 'query' | 'headers' | 'body' | 'response',
  expected: string | undefined,
  actual: string | undefined,
): void {
  if (expected !== actual)
    throw new Error(
      descriptor.operationId +
        ': ' +
        slot +
        ' contract binding must be ' +
        (expected ?? '<omitted>') +
        ', received ' +
        (actual ?? '<omitted>'),
    );
}

/** Binds framework schemas to pure references and projects all mounted metadata from one descriptor. */
export function bindOperation<const Schemas extends OperationSchemaBindings>(
  catalogue: OperationCatalogue,
  operationId: string,
  expectedMethod: OperationMethod,
  schemas: Schemas,
) {
  const descriptor = catalogue.get(operationId);
  if (!descriptor) throw new Error(operationId + ': operation descriptor is not registered');
  if (descriptor.method !== expectedMethod)
    throw new Error(
      descriptor.operationId +
        ': route builder expected ' +
        expectedMethod +
        ' but descriptor declares ' +
        descriptor.method,
    );

  for (const slot of ['params', 'query', 'headers', 'body'] as const)
    requireSchemaReference(descriptor, slot, descriptor.contracts[slot], schemas[slot]?.reference);
  requireSchemaReference(descriptor, 'response', descriptor.contracts.response, schemas.response.reference);

  const options = {
    ...(schemas.params === undefined ? {} : { params: schemas.params.schema }),
    ...(schemas.query === undefined ? {} : { query: schemas.query.schema }),
    ...(schemas.headers === undefined ? {} : { headers: schemas.headers.schema }),
    ...(schemas.body === undefined ? {} : { body: schemas.body.schema }),
    response: schemas.response.schema,
    detail: operationDetail(descriptor),
  };
  return {
    method: descriptor.method,
    path: descriptor.path,
    options,
  };
}
