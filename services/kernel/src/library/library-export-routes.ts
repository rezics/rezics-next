import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { defineRateLimit } from '../http/rate-limit.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { IDEMPOTENCY_HEADER } from '@rezics/operations/protocol';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { createLibraryExport, exportAuthorityTypes, type LibraryExportDependencies } from './library-export.ts';
import { exportSections } from './library-export-format.ts';

const closed = { additionalProperties: false } as const;
const params = t.Object({ id: t.String({ format: 'uuid' }) }, closed);
const text = t.String();
const nullable = t.Union([text, t.Null()]);
const sections = t.Tuple([
  t.Literal('entries'),
  t.Literal('labels'),
  t.Literal('assignments'),
  t.Literal('sessions'),
  t.Literal('holdings'),
  t.Literal('collections'),
  t.Literal('collectionPins'),
  t.Literal('bangumiUploads'),
  t.Literal('bangumiEvidence'),
  t.Literal('malImports'),
  t.Literal('units'),
  t.Literal('history'),
  t.Literal('occurrences'),
  t.Literal('malEvidence'),
  t.Literal('annotations'),
  t.Literal('provenance'),
  t.Literal('journals'),
  t.Literal('vndbUploads'),
  t.Literal('vndbEvidence'),
  t.Literal('anilistUploads'),
  t.Literal('anilistEvidence'),
]);
const manifestFields = {
  format: t.Literal('https://rezics.com/formats/library-export'),
  version: t.Literal(1),
  coverage: t.Literal('private-library-owner-facts-v1'),
  exportId: text,
  capturedAt: text,
  expiresAt: text,
  privacy: t.Literal('private'),
  completeness: t.Literal('supported-native-facts'),
  sections,
  omissions: t.Record(text, text),
  fullExport: t.Literal(false),
};
const state = t.Union([
  t.Literal('collecting'),
  t.Literal('ready'),
  t.Literal('stale'),
  t.Literal('cancelled'),
  t.Literal('expired'),
  t.Literal('limit'),
]);
const statusSchema = t.Object({ ...manifestFields, state, first: nullable }, closed);
const sectionTotal = t.Object({ rows: t.Integer({ minimum: 0 }), recordBytes: t.Integer({ minimum: 0 }) }, closed);
function sectionTotals() {
  return memoizedValue(sectionTotals, () =>
    t.Object(Object.fromEntries(exportSections.map((section) => [section, sectionTotal])), closed),
  );
}
const year = t.Integer({ minimum: 1, maximum: 9999 });
const month = t.Integer({ minimum: 1, maximum: 12 });
const day = t.Integer({ minimum: 1, maximum: 31 });
const date = t.Union([
  t.Object({ year }, closed),
  t.Object({ year, month }, closed),
  t.Object({ year, month, day }, closed),
]);
const nullableDate = t.Union([date, t.Null()]);
const privacyFact = t.Union([
  t.Object({ status: t.Literal('absent') }, closed),
  t.Object({ status: t.Literal('cleared') }, closed),
  t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(text) }, closed),
  t.Object(
    { status: t.Literal('known'), meaning: t.Union([t.Literal('private'), t.Literal('source_visible')]) },
    closed,
  ),
]);
const timestampFact = t.Union([
  t.Object({ status: t.Literal('absent') }, closed),
  t.Object({ status: t.Literal('cleared') }, closed),
  t.Object({ status: t.Literal('unknown'), sourceValue: t.Optional(text) }, closed),
  t.Object(
    {
      status: t.Literal('known'),
      value: text,
      precision: t.Union([
        t.Literal('year'),
        t.Literal('month'),
        t.Literal('day'),
        t.Literal('minute'),
        t.Literal('second'),
        t.Literal('fraction'),
      ]),
      zone: t.Union([t.Literal('utc'), t.Literal('offset'), t.Literal('unknown')]),
    },
    closed,
  ),
]);
const legacyRecord = t.Object(
  { section: t.Union(exportSections.map((section) => t.Literal(section))) },
  { additionalProperties: true },
);
const annotationRecord = t.Object(
  {
    section: t.Literal('annotations'),
    accountId: text,
    subjectId: text,
    entryIncarnationId: nullable,
    libraryProfilePin: t.Unknown(),
    annotationRevision: t.Integer({ minimum: 1 }),
    note: nullable,
    priority: t.Union([t.Integer({ minimum: 1, maximum: 100 }), t.Null()]),
    annotationUpdatedAt: nullable,
  },
  closed,
);
const provenanceRecord = t.Object(
  {
    section: t.Literal('provenance'),
    accountId: text,
    subjectId: text,
    entryIncarnationId: nullable,
    libraryProfilePin: t.Unknown(),
    observation: t.Object(
      {
        provider: text,
        recordId: text,
        revision: t.Integer({ minimum: 1 }),
        privacy: privacyFact,
        sourceCreated: timestampFact,
        sourceUpdated: timestampFact,
        recordedAt: text,
      },
      closed,
    ),
  },
  closed,
);
const journalRecordFields = {
  section: t.Literal('journals'),
  accountId: text,
  sessionId: text,
  subjectId: text,
  versionSubjectId: nullable,
  state: text,
  progressRevision: t.Integer({ minimum: 1 }),
  libraryProfilePin: t.Unknown(),
  startedAt: text,
  completedAt: nullable,
  lastChangedAt: nullable,
};
const journalRecord = t.Object(
  {
    ...journalRecordFields,
    journal: t.Object(
      {
        sessionId: text,
        revision: t.Integer({ minimum: 1 }),
        startDate: nullableDate,
        finishDate: nullableDate,
        reflection: nullable,
        assessment: t.Object(
          { meaningRevision: t.Literal(1), units: t.Union([t.Integer({ minimum: 0, maximum: 20 }), t.Null()]) },
          closed,
        ),
      },
      closed,
    ),
  },
  closed,
);
const vndbUploadRecord = t.Object(
  {
    section: t.Literal('vndbUploads'),
    upload_id: text,
    state: t.Union([t.Literal('active'), t.Literal('cancelled')]),
    expires_at: text,
  },
  closed,
);
const anilistUploadRecord = t.Object(
  {
    section: t.Literal('anilistUploads'),
    upload_id: text,
    cancelled: t.Union([t.Boolean(), t.Null()]),
    score_format: nullable,
    row_count: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  },
  closed,
);
const vndbEvidenceRecord = t.Object(
  { section: t.Literal('vndbEvidence'), upload_id: text, ordinal: t.Integer({ minimum: 0 }), evidence: t.Unknown() },
  closed,
);
const anilistEvidenceRecord = t.Object(
  { section: t.Literal('anilistEvidence'), upload_id: text, ordinal: t.Integer({ minimum: 0 }), evidence: t.Unknown() },
  closed,
);
const exportRecord = t.Union([
  legacyRecord,
  annotationRecord,
  provenanceRecord,
  journalRecord,
  vndbUploadRecord,
  anilistUploadRecord,
  vndbEvidenceRecord,
  anilistEvidenceRecord,
]);
function finalManifest() {
  return memoizedValue(finalManifest, () =>
    t.Object(
      {
        ...manifestFields,
        rows: t.Integer({ minimum: 0 }),
        recordBytes: t.Integer({ minimum: 0 }),
        sectionTotals: sectionTotals(),
      },
      closed,
    ),
  );
}
function pageSchema() {
  return memoizedValue(pageSchema, () =>
    t.Object(
      {
        exportId: text,
        state,
        records: t.Array(exportRecord, { maxItems: 16 }),
        next: nullable,
        manifest: t.Union([finalManifest(), t.Null()]),
      },
      closed,
    ),
  );
}
function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    422: problemSchema('idempotency_conflict'),
    503: problemSchema(
      'dependency_unavailable',
      'overloaded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'deadline_exceeded',
    ),
  }));
}
type ExportService = ReturnType<typeof createLibraryExport>;
type StatusOutput = Awaited<ReturnType<ExportService['get']>>;
type PageOutput = Awaited<ReturnType<ExportService['page']>>;

function statusView(value: StatusOutput): Static<typeof statusSchema> {
  return { ...value, sections: [...value.sections], omissions: { ...value.omissions } };
}
function finalManifestView(value: NonNullable<PageOutput['manifest']>): Static<ReturnType<typeof finalManifest>> {
  return {
    ...value,
    sections: [...value.sections],
    omissions: { ...value.omissions },
    sectionTotals: { ...value.sectionTotals },
  };
}

function pageView(value: PageOutput): Static<ReturnType<typeof pageSchema>> {
  return {
    exportId: value.exportId,
    state: value.state,
    records: value.records.map((record) => ({ ...record })),
    next: value.next,
    manifest: value.manifest === null ? null : finalManifestView(value.manifest),
  };
}
function requestSignal(request: Request, signal?: AbortSignal) {
  return signal ? AbortSignal.any([request.signal, signal]) : request.signal;
}
function detail(operationId: string, write = false) {
  return {
    operationId,
    'x-action': 'library_entry:list',
    'x-exposure': 'gate:personal_library',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': exportAuthorityTypes(),
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}

export function libraryExportRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<LibraryExportDependencies, 'access'> & { access: () => Access },
) {
  const service = () => createLibraryExport({ ...deps, access: deps.access() });
  return app
    .post(
      '/v1/libraryExports',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: text }),
        response: { 200: statusSchema, ...failures() },
        detail: detail('library_export.create', true),
      },
      async ({ request, actor, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          statusView(
            await service().create(
              actor,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              requestSignal(request, job.signal),
            ),
          ),
        );
      },
    )
    .get(
      '/v1/libraryExports/:id',
      {
        params,
        response: { 200: statusSchema, ...failures() },
        detail: detail('library_export.get'),
      },
      async ({ request, actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          statusView(await service().get(actor, params.id, requestSignal(request, job.signal))),
        );
      },
    )
    .get(
      '/v1/libraryExports/:id/pages',
      {
        params,
        query: t.Object({ cursor: t.String({ minLength: 1, maxLength: 4096 }) }, closed),
        response: { 200: pageSchema(), ...failures() },
        detail: detail('library_export.page'),
      },
      async ({ request, actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          pageView(await service().page(actor, params.id, query.cursor, requestSignal(request, job.signal))),
        );
      },
    )
    .delete(
      '/v1/libraryExports/:id',
      {
        params,
        response: { 200: statusSchema, ...failures() },
        detail: detail('library_export.cancel', true),
      },
      async ({ request, actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () =>
          statusView(await service().cancel(actor, params.id, requestSignal(request, job.signal))),
        );
      },
    );
}
