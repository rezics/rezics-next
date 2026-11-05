import { expect, mock, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubjectRead } from '@rezics/client';
import * as start from '../.storybook/react-start';
import recordedSubject from '../src/kernel/recorded/subject.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const { Cover, OverviewContext, Summary } = await import('../src/features/pages/overview');
const documentId = '00000000-0000-4000-8000-000000000010';
const digest = 'sha256:overview-subject-identity';

function projection(): SubjectRead {
  const body = structuredClone(recordedSubject) as unknown as SubjectRead;
  const statement = structuredClone(body.subject.statements['schema:abstract']![0]!);
  statement.value = { type: 'value', content: { language: 'en', document: documentId, digest } };
  body.subject.statements = { 'schema:abstract': [statement] };
  body.subject.descriptions = { en: 'Projection description' };
  Object.assign(body, {
    summary: {
      id: body.subject.id,
      type: 'schema:Book',
      label: { value: 'Projection title', language: 'en' },
      cover: {
        media: 'overview-projection-cover',
        width: 600,
        height: 800,
        placeholder: { color: '#465c72', thumbhash: '' },
        variants: [{ format: 'webp', width: 600 }],
        focalPoint: null,
        credit: null,
        withheld: null,
      },
    },
    documents: {
      [statement.id]: {
        id: documentId,
        subjectId: body.subject.id,
        candidateId: statement.id,
        digest,
        language: 'en',
        availability: 'available',
        body: fromPlainText('Projection document text'),
      },
    },
  });
  return body;
}

function render(plannedId: string, body: SubjectRead): string {
  const section = { ok: true as const, read: { kind: 'subject' as const, id: plannedId }, body };
  const value = {
    locale: 'en',
    subject: plannedId,
    subjectLabel: 'Configured subject',
    link: (() => null) as never,
    reader: { spoilerLevel: 0, suitability: 'blur' as const },
    labels: {
      spoilerShow: 'Show spoilers',
      documentSpoiler: 'Reveal passage',
      cover: { withheld: 'Sensitive cover', reveal: 'Show cover', credit: 'Cover credit', via: 'via' },
    },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Show spoilers',
    details: 'Details',
    cover: 'Cover',
    coverVia: 'via',
    licence: 'Licence',
    source: 'Source',
    sources: 'Sources',
    sections: new Map([
      ['cover', section],
      ['about', section],
    ]),
    relations: {},
    relationNodes: [],
  } as unknown as import('../src/features/pages/overview').OverviewValue;

  return renderToStaticMarkup(
    <OverviewContext.Provider value={value}>
      <>
        <Cover id="cover" />
        <Summary id="about" />
      </>
    </OverviewContext.Provider>,
  );
}

test('overview Subject projections render only when their nested identity matches the planned descriptor', () => {
  const body = projection();
  const ownId = body.subject.id;
  const matching = render(ownId, body);
  expect(matching).toContain('overview-projection-cover');
  expect(matching).toContain('Projection document text');

  const foreign = render('configured-subject', body);
  expect(foreign).not.toContain('overview-projection-cover');
  expect(foreign).not.toContain('Projection document text');
  expect(foreign).not.toContain('Projection description');

  const optionalDataMissing = structuredClone(body);
  Reflect.deleteProperty(optionalDataMissing, 'summary');
  Reflect.deleteProperty(optionalDataMissing, 'documents');
  expect(render(ownId, optionalDataMissing)).toContain('Projection description');
});
