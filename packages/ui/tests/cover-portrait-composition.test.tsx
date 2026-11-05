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
import { MemberListRow } from '../src/components/list-presentation.tsx';

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
