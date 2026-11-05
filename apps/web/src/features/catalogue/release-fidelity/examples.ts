import { createKernelClient, type SubjectRead } from '@rezics/client';
import definitions from '../../../kernel/recorded/definitions-release.json';
import { readReleaseFidelity } from './read';
import type { ReleaseFidelityTransport } from './view';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const visitRelease = id(1),
  visitTarget = id(2),
  visitWork = id(3),
  visitContext = id(4);
const source = visitRelease,
  target = visitTarget,
  work = visitWork,
  selectedContext = visitContext;

/** Actual released definitions; only native response data is supplied by this bounded producer. */
export function releaseVisitExample(context = selectedContext, type = 'wd:Q20631656') {
  const calls: { path: string; cursor: string | null; session: string | null; context: string | null }[] = [];
  const statement = (n: number, property: string, value: unknown) => ({
    id: id(n),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value,
    qualifiers: [],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://source.example/exact-release' },
          },
        ],
      },
    ],
    rezics: { release: definitions.digest, revision: 1 },
  });
  const subject = {
    id: source,
    type,
    context,
    release: definitions.digest,
    revision: 1,
    labels: { en: 'Long release title 日本語の長い題名 繁體中文版本' },
    descriptions: {},
    aliases: {},
    resolution: {},
    relationCounts: {},
    statements: {
      'schema:exampleOfWork': [statement(10, 'schema:exampleOfWork', { type: 'value', content: work })],
      'schema:datePublished': [
        {
          ...statement(11, 'schema:datePublished', {
            type: 'value',
            content: { time: '+2024-05-00T00:00:00Z', precision: 10 },
          }),
          property: { id: 'schema:datePublished', data_type: 'time' },
        },
      ],
    },
    sourceRecords: [{ name: 'Exact catalogue', url: 'https://source.example/catalogue' }],
  } as unknown as SubjectRead['subject'];
  let removed = false,
    concealed = false,
    unavailable = false;
  const client = createKernelClient('https://release.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        cursor: url.searchParams.get('cursor'),
        session: request.headers.get('rezics-session-token'),
        context: url.searchParams.get('context'),
      });
      if (url.pathname.includes('/definitions/releases/')) return Response.json(definitions);
      const labels = { en: 'Companion release 文庫' };
      const related = {
        [target]: { type, labels: concealed ? {} : labels },
        [work]: { type: type === 'bf:Instance' ? 'schema:Book' : 'wd:Q689445', labels: { en: 'Original work 原作' } },
      };
      if (url.pathname.endsWith('/relations') || url.pathname.endsWith('/links')) {
        const property = url.searchParams.get('property')!;
        const later = url.searchParams.get('cursor') === 'later';
        const rows = Array.from({ length: removed ? 0 : later ? 2 : 20 }, (_, index) => ({
          statement: statement((later ? 200 : 100) + index, property, { type: 'value', content: target }),
          summary: {
            id: target,
            type: property === 'schema:associatedMedia' ? 'schema:MediaObject' : type,
            types: [type],
            label: concealed ? undefined : { value: labels.en, language: 'en' },
            creativeWork: true,
            cover: null,
          },
          related: { [target]: { type, label: concealed ? undefined : { value: labels.en, language: 'en' } } },
        }));
        return Response.json(
          {
            relations: rows,
            links: rows.map((row) => ({
              ...row,
              subject: target,
              assertion: row.statement,
              statement: row.statement.id,
            })),
            next: later || removed ? null : 'later',
          },
          { headers: { 'rezics-session-token': 'native-current-session' } },
        );
      }
      if (!url.pathname.endsWith(source) && unavailable) return Response.json({}, { status: 503 });
      const detail = url.pathname.endsWith(target);
      return Response.json({
        subject: detail
          ? {
              ...subject,
              id: target,
              labels,
              statements: {
                'schema:datePublished': [
                  {
                    ...statement(12, 'schema:datePublished', { type: 'somevalue' }),
                    property: { id: 'schema:datePublished', data_type: 'time' },
                  },
                ],
              },
            }
          : subject,
        related,
        account: null,
        summary: null,
      });
    }) as typeof fetch,
  });
  const read: ReleaseFidelityTransport['read'] = (stream, cursor, detail, session, returning) =>
    readReleaseFidelity(client, 'Bearer reader', {
      id: source,
      context,
      locale: 'en',
      stream,
      cursor,
      detail,
      session,
      returning,
    });
  return {
    read,
    calls,
    subject,
    remove: () => {
      removed = true;
    },
    conceal: () => {
      concealed = true;
    },
    failTarget: () => {
      unavailable = true;
    },
  };
}
