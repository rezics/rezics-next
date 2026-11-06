import type { KernelClient } from '@rezics/client';
import {
  closedPublicationOperations,
  grantedPublicationOperations,
  isPublicationDigest,
  PUBLICATION_GRANT,
  type PublicationOperations,
} from '@rezics/definitions';
import {
  activateBody,
  commandPath,
  previewFailure,
  publishBody,
  quotedPublicationKey,
  type CatalogueBuildStatus,
  type PublicationCommand,
  type PublicationFailure,
  type PublicationPreview,
  type PublicationRead,
  type PublicationResult,
  type PublicationScope,
  type PublicationTransport,
} from './model';

type KernelResult = { status: number; data?: unknown; error?: { value?: unknown } | null };
type WriteOptions = { headers?: Record<string, string> };
type ImportClient = {
  definitions: {
    imports: {
      post(
        body: { document: unknown; context?: string; expected_head?: number | null },
        options?: WriteOptions,
      ): Promise<KernelResult>;
    };
    catalogues: {
      post(body: unknown, options?: WriteOptions): Promise<KernelResult>;
      (params: { root: string }): {
        $step: { post(body: Record<string, never>, options?: WriteOptions): Promise<KernelResult> };
        $activate: { post(body: { expected_head: number | null }, options?: WriteOptions): Promise<KernelResult> };
        build: { get(options?: WriteOptions): Promise<KernelResult> };
      };
    };
  };
  contexts(params: { id: string }): {
    definitions: {
      get(options?: WriteOptions): Promise<KernelResult>;
      extensions: {
        post(body: { extension: unknown }, options?: WriteOptions): Promise<KernelResult>;
        (params: { digest: string }): {
          get(options?: WriteOptions): Promise<KernelResult>;
          $activate: { post(body: { expected_head: number | null }, options?: WriteOptions): Promise<KernelResult> };
        };
      };
    };
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function problemCode(data: unknown): string | undefined {
  return record(data) && typeof data.code === 'string' ? data.code : undefined;
}

function operationsFrom(admitted: readonly string[] | undefined, granted: boolean): PublicationOperations {
  if (!granted && !admitted?.includes(PUBLICATION_GRANT)) return closedPublicationOperations();
  return grantedPublicationOperations();
}

function previewValue(value: unknown): PublicationPreview | null {
  if (!record(value) || typeof value.kind !== 'string') return null;
  if (!['release', 'sources', 'extension', 'invalid'].includes(value.kind)) return null;
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 64) return null;
  const identity = record(value.identity)
    ? {
        digest: typeof value.identity.digest === 'string' ? value.identity.digest : '',
        version: typeof value.identity.version === 'string' ? value.identity.version : null,
        format: typeof value.identity.format === 'string' ? value.identity.format : '',
      }
    : null;
  if (identity && identity.digest && !isPublicationDigest(identity.digest)) return null;
  const document = record(value.document) ? value.document : null;
  return { ...value, document } as PublicationPreview;
}

function writeHeaders(authorization: string, key: string): Record<string, string> {
  return { authorization, 'idempotency-key': quotedPublicationKey(key) };
}

function failureOf(result: KernelResult): PublicationFailure {
  return previewFailure(result.status, problemCode(result.data ?? result.error?.value));
}

export function definitionPublicationNative(
  client: KernelClient,
  headers: Record<string, string> = {},
): PublicationTransport {
  const imports = client as unknown as ImportClient;
  const authorization = headers.authorization ?? '';
  return {
    async open(scope, context) {
      try {
        const exposure = await client.platform.exposure.get({ headers });
        if (exposure.status === 401) return { ok: false, reason: 'denied' };
        if (exposure.status === 403) return { ok: false, reason: previewFailure(403, problemCode(exposure.data)) };
        if (exposure.status !== 200 || !record(exposure.data) || !Array.isArray(exposure.data.admitted))
          return { ok: false, reason: 'unavailable' };
        const admitted = exposure.data.admitted as string[];
        const operations = operationsFrom(admitted, admitted.includes(PUBLICATION_GRANT));
        if (!operations.admitted) {
          return { ok: true, phase: 'closed', scope, operations, current: null, ...(context ? { context } : {}) };
        }
        if (scope === 'context' && context) {
          const current = await imports.contexts({ id: context }).definitions.get({ headers });
          if (current.status === 404) return { ok: false, reason: 'missing' };
          if (current.status !== 200 || !record(current.data)) return { ok: false, reason: failureOf(current) };
          const digest = typeof current.data.digest === 'string' ? current.data.digest : null;
          const head = typeof current.data.head === 'number' ? current.data.head : 0;
          return {
            ok: true,
            phase: 'idle',
            scope,
            operations,
            current: digest && isPublicationDigest(digest) ? { digest, head } : null,
            context,
          };
        }
        const active = await client.definitions.active.get({ headers });
        if (active.status === 404) return { ok: true, phase: 'idle', scope, operations, current: null };
        if (active.status !== 200 || !record(active.data) || typeof active.data.digest !== 'string')
          return { ok: false, reason: failureOf(active) };
        return {
          ok: true,
          phase: 'idle',
          scope,
          operations,
          current: { digest: active.data.digest as string, head: Number(active.data.head) },
        };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async preview(document, context, expectedHead) {
      try {
        const result = await imports.definitions.imports.post(
          {
            document,
            ...(context ? { context } : {}),
            ...(expectedHead === undefined ? {} : { expected_head: expectedHead }),
          },
          { headers },
        );
        if (result.status !== 200) return { ok: false, reason: failureOf(result) };
        const preview = previewValue(result.data);
        return preview ?? { ok: false, reason: 'invalid' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async submit(command) {
      try {
        const write = writeHeaders(authorization, command.key);
        const result = await fetchCommand(imports, client, command, write);
        if (result.status === 409) {
          const expected =
            record(result.data) && record(result.data.current) && typeof result.data.current.head === 'number'
              ? result.data.current.head
              : undefined;
          return { ok: false, reason: 'stale', ...(expected === undefined ? {} : { expectedHead: expected }) };
        }
        if (result.status !== 200 && result.status !== 201) return { ok: false, reason: failureOf(result) };
        if (!record(result.data) || typeof result.data.digest !== 'string') {
          if (record(result.data) && record(result.data.pin) && typeof result.data.pin.rootDigest === 'string') {
            return {
              ok: true,
              status: result.status,
              result: {
                digest: result.data.pin.rootDigest as string,
                ...(typeof result.data.head === 'number' ? { head: result.data.head } : {}),
                pin: { rootDigest: result.data.pin.rootDigest as string },
              },
            };
          }
          return { ok: false, reason: 'invalid' };
        }
        return {
          ok: true,
          status: result.status,
          result: {
            digest: result.data.digest as string,
            ...(typeof result.data.head === 'number' ? { head: result.data.head } : {}),
          },
        };
      } catch {
        return { ok: false, reason: 'uncertain' };
      }
    },
    async readRelease(digest) {
      try {
        const result = await client.definitions.releases({ digest }).get({ headers });
        if (result.status !== 200 || !record(result.data) || result.data.digest !== digest)
          return { ok: false, reason: failureOf(result) };
        return { ok: true, digest };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async readExtension(context, digest) {
      try {
        const result = await imports.contexts({ id: context }).definitions.extensions({ digest }).get({ headers });
        if (result.status !== 200 || !record(result.data) || result.data.digest !== digest)
          return { ok: false, reason: failureOf(result) };
        return { ok: true, digest };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async readBuild(root) {
      try {
        const result = await imports.definitions.catalogues({ root }).build.get({ headers });
        if (result.status !== 200 || !record(result.data) || !record(result.data.pin))
          return { ok: false, reason: failureOf(result) };
        return result.data as CatalogueBuildStatus;
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async createSubject(type, key) {
      try {
        const result = await client.subjects.post(
          { type, labels: { en: type } },
          { headers: writeHeaders(authorization, key) },
        );
        if ((result.status !== 200 && result.status !== 201) || !record(result.data) || !record(result.data.subject))
          return { ok: false, reason: failureOf(result) };
        const id = result.data.subject.id;
        return typeof id === 'string' ? { ok: true, id } : { ok: false, reason: 'invalid' };
      } catch {
        return { ok: false, reason: 'uncertain' };
      }
    },
    async readSubject(id) {
      try {
        const result = await client.subjects({ id }).get({ headers });
        if (result.status !== 200 || !record(result.data) || !record(result.data.subject))
          return { ok: false, reason: failureOf(result) };
        const subject = result.data.subject;
        return typeof subject.id === 'string' && typeof subject.type === 'string'
          ? { ok: true, id: subject.id, type: subject.type }
          : { ok: false, reason: 'invalid' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
  };
}

async function fetchCommand(
  imports: ImportClient,
  client: KernelClient,
  command: PublicationCommand,
  headers: Record<string, string>,
): Promise<KernelResult> {
  if (command.operation === 'publish' && command.path.includes('/extensions')) {
    const context = command.path.split('/')[3];
    return imports
      .contexts({ id: context! })
      .definitions.extensions.post(command.body as { extension: unknown }, { headers });
  }
  if (command.operation === 'activate' && command.path.includes('/extensions/')) {
    const parts = command.path.split('/');
    return imports
      .contexts({ id: parts[3]! })
      .definitions.extensions({ digest: parts[6]!.replace(/:activate$/, '') })
      .$activate.post(command.body as { expected_head: number | null }, { headers });
  }
  if (command.operation === 'activate' && command.path.includes('/releases/')) {
    const digest = command.path.split('/')[4]!.replace(/:activate$/, '');
    return client.definitions.releases({ digest }).$activate.post(command.body as { expected_head: number | null }, {
      headers,
    });
  }
  if (command.operation === 'publish') {
    return client.definitions.releases.post(command.body as { release: Record<string, unknown> }, { headers });
  }
  if (command.operation === 'build') {
    return imports.definitions.catalogues.post(command.body, { headers });
  }
  const root = command.path.split('/')[4]!.replace(/:step$/, '');
  return imports.definitions.catalogues({ root }).$step.post({}, { headers });
}

export function publicationCommand(
  scope: PublicationScope,
  operation: PublicationCommand['operation'],
  key: string,
  identity: Parameters<typeof commandPath>[2],
  body: Record<string, unknown>,
  context?: string,
): PublicationCommand {
  return { key, operation, body, path: commandPath(scope, operation, identity, context) };
}

export { activateBody, publishBody };
