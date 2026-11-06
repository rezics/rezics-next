import { createServerFn } from '@tanstack/react-start';
import { withCatalogueSession } from '../definition-guide-actions';
import { definitionPublicationNative } from './native';
import {
  isPublicationDigest,
  publicationDocument,
  type PublicationCommand,
  type PublicationFailure,
  type PublicationPreview,
  type PublicationRead,
  type PublicationScope,
} from './model';

function requestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publication request');
  return value as Record<string, unknown>;
}

export function publicationAddress(value: unknown): { scope: PublicationScope; context?: string } {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const context =
    typeof input.context === 'string' && /^[0-9a-f-]{36}$/i.test(input.context) ? input.context : undefined;
  return { scope: context ? 'context' : 'platform', ...(context ? { context } : {}) };
}

async function withPublisher<T>(
  read: (
    native: ReturnType<typeof definitionPublicationNative>,
  ) => Promise<T | { ok: false; reason: PublicationFailure }>,
): Promise<T | { ok: false; reason: PublicationFailure }> {
  return withCatalogueSession(({ client, authorization }) =>
    read(definitionPublicationNative(client, { authorization })),
  );
}

export const openDefinitionPublication = createServerFn({ method: 'GET' })
  .validator((value: unknown) => publicationAddress(value))
  .handler(async ({ data }): Promise<PublicationRead> =>
    withPublisher((native) => native.open(data.scope, data.context)),
  );

export const previewDefinitionPublication = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    const input = requestObject(value);
    const address = publicationAddress(input);
    const document = publicationDocument(input.document);
    if (!document) throw new Error('Invalid publication document');
    const expectedHead =
      input.expectedHead === null
        ? null
        : typeof input.expectedHead === 'number' && Number.isInteger(input.expectedHead)
          ? input.expectedHead
          : undefined;
    if (expectedHead !== undefined && expectedHead !== null && (expectedHead < 1 || expectedHead > 2147483646))
      throw new Error('Invalid editorial head');
    return { ...address, document, ...(expectedHead === undefined ? {} : { expectedHead }) };
  })
  .handler(async ({ data }): Promise<PublicationPreview | { ok: false; reason: PublicationFailure }> =>
    withPublisher((native) => native.preview(data.document, data.context, data.expectedHead ?? null)),
  );

export const submitDefinitionPublication = createServerFn({ method: 'POST' })
  .validator((value: unknown): PublicationCommand => {
    const input = requestObject(value);
    if (typeof input.key !== 'string' || input.key.length < 3 || input.key.length > 1024)
      throw new Error('Invalid publication key');
    if (
      input.operation !== 'publish' &&
      input.operation !== 'activate' &&
      input.operation !== 'build' &&
      input.operation !== 'step'
    )
      throw new Error('Invalid publication operation');
    if (typeof input.path !== 'string' || input.path.length > 2048) throw new Error('Invalid publication path');
    const body = publicationDocument(input.body);
    if (!body) throw new Error('Invalid publication body');
    return {
      key: input.key,
      operation: input.operation,
      path: input.path,
      body,
    };
  })
  .handler(async ({ data }) => withPublisher((native) => native.submit(data)));

export const readDefinitionPublicationRelease = createServerFn({ method: 'GET' })
  .validator((digest: unknown) => {
    if (typeof digest !== 'string' || !isPublicationDigest(digest)) throw new Error('Invalid release digest');
    return digest;
  })
  .handler(async ({ data }) => withPublisher((native) => native.readRelease(data)));

export const readDefinitionPublicationExtension = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    const input = requestObject(value);
    if (typeof input.context !== 'string' || typeof input.digest !== 'string' || !isPublicationDigest(input.digest))
      throw new Error('Invalid extension read');
    return { context: input.context, digest: input.digest };
  })
  .handler(async ({ data }) => withPublisher((native) => native.readExtension(data.context, data.digest)));

export const readDefinitionPublicationBuild = createServerFn({ method: 'GET' })
  .validator((root: unknown) => {
    if (typeof root !== 'string' || !isPublicationDigest(root)) throw new Error('Invalid catalogue root');
    return root;
  })
  .handler(async ({ data }) => withPublisher((native) => native.readBuild(data)));

export const createDefinitionPublicationSubject = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    const input = requestObject(value);
    if (typeof input.type !== 'string' || input.type.length === 0 || input.type.length > 4096)
      throw new Error('Invalid Type');
    if (typeof input.key !== 'string' || input.key.length < 3) throw new Error('Invalid subject key');
    return { type: input.type, key: input.key };
  })
  .handler(async ({ data }) => withPublisher((native) => native.createSubject(data.type, data.key)));

export const readDefinitionPublicationSubject = createServerFn({ method: 'GET' })
  .validator((id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid subject');
    return id;
  })
  .handler(async ({ data }) => withPublisher((native) => native.readSubject(data)));
