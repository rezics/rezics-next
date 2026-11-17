import { dirname } from 'node:path';

const uuid = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const id = (value: unknown) => (typeof value === 'string' && uuid.test(value) ? value : null);

/** Retain exact identities privately for boundary comparisons, without names, evidence or credentials. */
export function archiveLabelIdentity(value: unknown) {
  const body = record(value);
  if (!body) return null;
  for (const kind of ['applied', 'results'] as const) {
    const rows = body[kind];
    if (!Array.isArray(rows)) continue;
    return {
      kind,
      uploadId: id(body.uploadId),
      labels: rows.slice(0, 100).flatMap((row: unknown) => {
        const item = record(row);
        const result = record(item?.result);
        const labelId = id(result?.labelId);
        return Number.isSafeInteger(item?.ordinal) && result?.effect === 'label.create' && labelId
          ? [{ ordinal: item!.ordinal as number, labelId }]
          : [];
      }),
      labelId: null,
      labelIds: [] as string[],
    };
  }
  if (Array.isArray(body.labels))
    return {
      kind: 'labels',
      uploadId: null,
      labels: [],
      labelId: null,
      labelIds: body.labels.slice(0, 100).flatMap((row: unknown) => {
        const labelId = id(record(row)?.id);
        return labelId ? [labelId] : [];
      }),
    };
  const labelId = id(record(body.label)?.id);
  return labelId ? { kind: 'label', uploadId: null, labels: [], labelId, labelIds: [] as string[] } : null;
}

/** Use the installed server-function codec on the actual response captured by Playwright. */
export async function archiveLabelServerReply(value: unknown) {
  const start = Bun.resolveSync('@tanstack/react-start', import.meta.dir);
  const core = Bun.resolveSync('@tanstack/start-client-core', dirname(start));
  const { fromCrossJSON } = await import(Bun.resolveSync('seroval', dirname(core)));
  const envelope = record(fromCrossJSON(value, {}));
  const reply = record(envelope?.result);
  return reply?.kind === 'ok' ? archiveLabelIdentity(reply.value) : null;
}

export type ArchiveLabelIdentity = ReturnType<typeof archiveLabelIdentity>;
