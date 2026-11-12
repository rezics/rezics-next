import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import release from '../../definitions/release/rezics.json';
import {
  Cover,
  listPresentationForCover,
  parseCoverRatio,
  type CoverSubject,
  type CoverSummary,
} from '../src/components/cover.tsx';
import { CoverCard, CoverGrid } from '../src/components/cover-card.tsx';
import { ShelfListRow } from '@rezics/ui/shelf-list';
import { ShelfTable } from '@rezics/ui/shelf-table';
import { MemberListRow, MemberReadingItem } from '../src/components/list-presentation.tsx';
import { ratioValue } from '../src/components/cover-model.ts';

test('Card density bounds the effective frame while standalone and hero covers keep their sizes', () => {
  const subject = { id: 'book', title: 'A book', types: ['schema:Book'] };
  for (const [density, height] of [
    ['small', 134.4],
    ['medium', 224],
    ['large', 336],
  ] as const) {
    for (const [imageAspect, ratio] of [
      ['portrait', '5:7'],
      ['landscape', '16:9'],
      ['square', '1:1'],
    ] as const) {
      const cover = { subject, cover: null, src: () => '', listPresentation: { imageAspect, keyFacts: [] } };
      const html = renderToStaticMarkup(
        <CoverGrid ratio="2:3" density={density}>
          <CoverCard title={subject.title} cover={cover} />
        </CoverGrid>,
      );
      expect(html).toContain(`width:min(100%, ${height * ratioValue(ratio)}px);max-block-size:${height}px`);
      expect(html).toContain(`data-ratio="${ratio}"`);
    }
  }
  for (const size of ['fill', 'lg'] as const) {
    const html = renderToStaticMarkup(<Cover subject={subject} cover={null} src={() => ''} size={size} />);
    expect(html).toContain(`style="width:${size === 'fill' ? '100%' : '240px'}"`);
    expect(html).not.toContain('max-block-size');
  }
});

test('Every default catalogue kind uses a portrait cover frame while landscape artwork remains whole', () => {
  const wide: CoverSummary = {
    media: 'authorized-wide-art',
    width: 1600,
    height: 900,
    variants: [{ format: 'webp', width: 640 }],
    placeholder: { color: '#465c72', thumbhash: '' },
    focalPoint: { x: 0.25, y: 0.75 },
    credit: { rightsHolder: 'Artwork owner' },
  };
  const src = (media: string) => `/media/${media}`;
  for (const [type, definition] of Object.entries(release.types)) {
    const subject: CoverSubject = { id: type, title: `Identity of ${type}`, types: [type, ...definition.bases] };
    // Exercise the effective released object and the older-release/unknown-Type fallback through real renderers.
    for (const annotation of [definition.listPresentation, undefined]) {
      const listPresentation = listPresentationForCover(subject, annotation);
      for (const cover of [wide, null]) {
        const surfaces = [
          <Cover
            subject={subject}
            cover={cover}
            size="md"
            src={src}
            ratio={annotation ? parseCoverRatio(definition.coverRatio) : undefined}
          />,
          <CoverGrid ratio="5:7">
            <CoverCard title={subject.title} cover={{ subject, cover, src, listPresentation }} />
          </CoverGrid>,
          <ul>
            <MemberListRow
              href="/subject"
              subject={subject}
              title={subject.title}
              cover={cover}
              src={src}
              listPresentation={listPresentation}
            />
          </ul>,
        ];
        for (const surface of surfaces) {
          const html = renderToStaticMarkup(surface);
          expect(html, type).toContain('data-ratio="5:7"');
          if (cover) {
            expect(html, type).toContain('data-fit="contain"');
            expect(html, type).toContain('object-contain');
            expect(html, type).toContain('src="/media/authorized-wide-art"');
            expect(html, type).toContain('data-state="loading"');
          } else {
            expect(html, type).toContain('data-state="placeholder"');
            expect(html, type).toContain(subject.title);
            expect(html, type).not.toContain('<img');
          }
        }
      }
    }
  }
});

test('Shelf adapters leave explicit and configured cover geometry to Cover for image and fallback states', () => {
  const subject: CoverSubject = { id: 'supplied', title: 'A supplied work', types: ['schema:Book'] };
  const image: CoverSummary = {
    media: 'supplied-art',
    width: 1600,
    height: 900,
    variants: [{ format: 'webp', width: 640 }],
    placeholder: { color: '#465c72', thumbhash: '' },
    focalPoint: null,
    credit: null,
  };
  for (const imageAspect of [undefined, 'square', 'landscape'] as const) {
    const expectedRatio = imageAspect === 'square' ? '1:1' : '16:9';
    for (const cover of [image, { ...image, withheld: 'suitability' as const }, null]) {
      const props = {
        subject,
        cover,
        src: () => '/supplied-art',
        ratio: '16:9' as const,
        ...(imageAspect ? { listPresentation: { imageAspect, keyFacts: [] } } : {}),
      };
      const surfaces = [
        <ul>
          <ShelfListRow
            href="/supplied"
            title={subject.title}
            cover={props}
            labels={{ select: 'Select', menu: 'More' }}
          />
        </ul>,
        <ShelfTable
          columns={[{ id: 'cover', label: 'Cover', visible: true }]}
          rows={[{ id: subject.id, href: '/supplied', title: subject.title, cover: props }]}
          onSort={() => {}}
        />,
      ];
      for (const surface of surfaces) {
        const html = renderToStaticMarkup(surface);
        expect(html).toContain(`data-ratio="${expectedRatio}"`);
        expect(html).not.toContain('overflow-hidden rounded');
        expect(html).not.toContain('pointer-events-none w-');
        expect(html).toContain(
          cover?.withheld ? 'data-state="withheld"' : cover ? 'data-state="loading"' : 'data-state="placeholder"',
        );
        if (cover?.withheld) {
          expect(html).toContain('min-h-11 min-w-11');
          expect(html).toContain('aria-label="Show cover"');
          expect(html).not.toContain('<img');
        }
      }
    }
  }
});

test('Collection reading rows keep wrapped identity and Inspect in measured flow', () => {
  const title = 'A supplied long title '.repeat(16);
  const html = renderToStaticMarkup(
    <ul>
      <MemberReadingItem
        layout="list"
        occurrenceLabel="Supplied occurrence"
        detailId="supplied-detail"
        expanded={false}
        href="/supplied"
        title={title}
        position="One of the supplied occurrences"
        inspectLabel="Inspect supplied occurrence"
        onInspect={() => {}}
        metadata={<p>A supplied summary that remains bounded to four lines.</p>}
      />
    </ul>,
  );
  expect(html).toContain(title);
  expect(html).toContain('Inspect supplied occurrence');
  expect(html).toContain('line-clamp-4');
  expect(html).not.toContain('max-h-48');
  expect(html).not.toContain('overflow-y-auto');
});
