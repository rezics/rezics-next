import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { DocumentSnapshot } from '@rezics/document';
import recorded from '../src/kernel/recorded/subject.json';
import { PublishedPresentationPage } from '../src/features/pages/presentation-preview-view';
import { subjectPageMessages } from '../src/features/pages/route-support';
import { DocumentValue } from '../src/features/pages/values';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

const controls: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      { type: 'image', attrs: { src: 'private-image', alt: '' } },
      { type: 'taskList', content: [{ type: 'taskItem', content: [{ type: 'paragraph' }] }] },
      { type: 'extensionBlock', attrs: { definition: 'unknown-block', fallback: null } },
    ],
  },
};

test('Subject rendering with an explicit locale uses that locale for page messages and embedded document controls even when the ambient route locale differs.', () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const locale = 'ja';
    const options = { locale: locale as never };
    const composition: CompositionDocument = {
      root: { props: {} },
      content: [{ type: 'SubjectHeader', props: { id: 'header' } }],
    };
    const subject = recorded.subject.id;
    const plan = planReads(platformRegistry, composition, { subject });
    const preview = renderToStaticMarkup(
      createElement(PublishedPresentationPage, {
        result: {
          ok: true,
          target: { subject },
          locale,
          head: 1,
          page: {
            subject,
            profile: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            template: { scope: 'generic', key: null },
            document: composition,
            reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: recorded }])),
          },
        },
      }),
    );
    expect(subjectPageMessages(locale).aliases).toBe(m.subject_aliases({}, options));
    expect(preview).toContain(m.subject_aliases({}, options));
    expect(preview).not.toContain(m.subject_aliases());
    const html = renderToStaticMarkup(
      createElement(DocumentValue, {
        document: controls,
        lang: 'fr',
        locale,
        labels: {
          documentSpoiler: m.thread_reveal_spoiler({}, options),
          spoilerShow: '',
          cover: { withheld: '', reveal: '', credit: '', via: '' },
        },
      }),
    );
    expect(html).toContain('lang="fr"');
    expect(html).toContain(m.document_task_status({}, options));
    expect(html).toContain(m.document_embedded_component({}, options));
    expect(html).toContain(m.content_edition_image_unavailable({}, options));
    expect(html).not.toContain(m.document_task_status());
    expect(html).not.toContain(m.document_embedded_component());
    expect(html).not.toContain(m.content_edition_image_unavailable());
  } finally {
    setLocale(previous, { reload: false });
  }
});
