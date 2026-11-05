import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { collectionRequestVariant, loadEditableCollectionPage } from './collection-load';
import type { CollectionPublicContext } from './collection-public-document';
import {
  finishCollectionExport,
  validateCollectionExportCapture,
  type CollectionExportCapture,
} from './collection-export-request';

/** Reconstruct the exact addressed read; later pages and malformed address claims cannot silently restart. */
function exportAddress(capture: CollectionExportCapture): {
  id: string;
  editor: boolean;
  search: Record<string, string | string[]>;
} {
  const [kind, id, cursor, editor, entries] = JSON.parse(capture.provenance.request);
  if (kind !== 'page' || id !== capture.id || cursor !== null || typeof editor !== 'boolean' || !Array.isArray(entries))
    throw new Error('Invalid Collection export address');
  const search: Record<string, string | string[]> = {};
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !(
        typeof entry[1] === 'string' ||
        (Array.isArray(entry[1]) && entry[1].every((value: unknown) => typeof value === 'string'))
      )
    )
      throw new Error('Invalid Collection export search');
    search[entry[0]] = entry[1];
  }
  const address = { id, editor, search };
  if (collectionRequestVariant(address) !== capture.provenance.request)
    throw new Error('Invalid Collection export address');
  return address;
}

export async function loadCollectionExport(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  capture: CollectionExportCapture,
  context: CollectionPublicContext,
) {
  return finishCollectionExport(capture, context, () =>
    loadEditableCollectionPage(
      client,
      request,
      sessionEnv,
      {
        ...exportAddress(capture),
        ...(capture.filter ? { filter: capture.filter } : {}),
      },
      capture.provenance.mode,
    ),
  );
}

export const readCollectionExport = createServerFn({ method: 'POST' })
  .validator((input: { capture: unknown; context: CollectionPublicContext }) => ({
    capture: validateCollectionExportCapture(input.capture),
    context: input.context,
  }))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCollectionExport(kernelClient(), getRequest(), env as Partial<SessionEnv>, data.capture, data.context);
  });
