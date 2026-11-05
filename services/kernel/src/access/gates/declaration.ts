import { parseExposureDeclaration, type Exposure } from '@rezics/access';

export type { Exposure } from '@rezics/access';

/** Parse trusted route metadata once, when the production kernel is composed. */
export function parseExposure(detail: unknown): Exposure {
  const metadata =
    typeof detail === 'object' && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : undefined;
  try {
    return parseExposureDeclaration(metadata?.['x-exposure']);
  } catch {
    const route = typeof metadata?.operationId === 'string' ? metadata.operationId : '<unnamed route>';
    throw new Error(`${route}: routes declare x-exposure as public or gate:<group> with a valid, non-reserved group`);
  }
}
