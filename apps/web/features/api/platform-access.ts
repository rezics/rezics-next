import {
  type PlatformAccessSummary,
  type PlatformOperationId,
  platformOperationOpen,
} from '../../../../generated/openapi/main/exposure.ts';

// What is open for the viewer. Main's generated exposure says which group each operation belongs to and
// `GET /v1/me/platform-access` says which groups and operations this viewer holds; the web only hides what
// Main would refuse, it never decides authority. Client-safe: no server imports.

export type { PlatformOperationId };
export type PlatformAccess = PlatformAccessSummary;

/** What an anonymous viewer holds, and what the web assumes when the read fails: only public operations. */
export const NO_PLATFORM_ACCESS: PlatformAccess = { groups: [], operations: [], generation: '' };

const strings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

/** The platform-access answer when it has the contract's shape, else null. */
export function parsePlatformAccess(value: unknown): PlatformAccess | null {
  if (!value || typeof value !== 'object') return null;
  const { groups, operations, generation } = value as Record<string, unknown>;
  const held = strings(groups);
  const named = strings(operations);
  return held && named && typeof generation === 'string' ? { groups: held, operations: named, generation } : null;
}

/** Whether the viewer may call `operation`. A missing read counts as holding nothing. */
export function operationOpen(operation: PlatformOperationId, access: PlatformAccess | null): boolean {
  return platformOperationOpen(operation, access ?? NO_PLATFORM_ACCESS);
}

/** `operationOpen` bound to one viewer, for code that gates several operations. */
export type OperationGate = (operation: PlatformOperationId) => boolean;

export const gateFor =
  (access: PlatformAccess | null): OperationGate =>
  (operation) =>
    operationOpen(operation, access);

/** Main's refusal of a closed operation: 403 with problem code `platform_closed`. */
export function platformClosed(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'platform_closed'
  );
}
