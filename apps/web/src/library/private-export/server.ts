import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { EXPORT_CURSOR_CHARS, SUBJECT_ID, type ExportCommand } from './contract';
import { kernelExportPort } from './native';

function originConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function port() {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelExportPort(kernelClient(), getRequest(), env as Partial<SessionEnv>, originConfigured());
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !SUBJECT_ID.test(value)) throw new Error('Invalid Library export');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) throw new Error('Invalid Library export');
  return value;
}

function requireCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > EXPORT_CURSOR_CHARS)
    throw new Error('Invalid Library export');
  return value;
}

export const createLibraryExport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<ExportCommand, { kind: 'create' }> => {
    if (!input || typeof input !== 'object' || !('key' in input)) throw new Error('Invalid Library export');
    return { kind: 'create', key: requireKey(input.key) };
  })
  .handler(async ({ data }) => port().create(data));

export const readLibraryExport = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<ExportCommand, { kind: 'status' }> => {
    if (!input || typeof input !== 'object' || !('exportId' in input)) throw new Error('Invalid Library export');
    return { kind: 'status', exportId: requireId(input.exportId) };
  })
  .handler(async ({ data }) => port().status(data));

export const readLibraryExportPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<ExportCommand, { kind: 'page' }> => {
    if (!input || typeof input !== 'object' || !('exportId' in input) || !('cursor' in input))
      throw new Error('Invalid Library export');
    return { kind: 'page', exportId: requireId(input.exportId), cursor: requireCursor(input.cursor) };
  })
  .handler(async ({ data }) => port().page(data));

export const cancelLibraryExport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<ExportCommand, { kind: 'cancel' }> => {
    if (!input || typeof input !== 'object' || !('exportId' in input)) throw new Error('Invalid Library export');
    return { kind: 'cancel', exportId: requireId(input.exportId) };
  })
  .handler(async ({ data }) => port().cancel(data));
