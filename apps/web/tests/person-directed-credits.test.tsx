import { expect, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { ReleasedRelationDirectionResult } from '@rezics/definitions';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { dataComponents, PageData, type PageMessages } from '../src/features/pages/data.tsx';
import { layoutComponents, pageDefinitions, PageRoot } from '../src/features/pages/layout.tsx';
import { CompositionRender } from '../src/features/pages/render.tsx';

const person = '019a1b2c-3d4e-7f00-8a00-ed170e000001';
const work = '019a1b2c-3d4e-7f00-8a00-ed170e000002';
const statement = '019a1b2c-3d4e-7f00-8a00-ed170e000003';
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
};
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'SubjectList',
      props: { id: 'contributions', title: { en: 'General contributions' }, property: 'schema:author', limit: 6 },
    },
    { type: 'SubjectList', props: { id: 'voice', title: { en: 'Voice credits' }, property: 'wdt:P725', limit: 6 } },
  ],
};
const direction = (property: string): ReleasedRelationDirectionResult => ({
  state: 'admitted',
  property,
  direction: 'inverse',
  inverse: `rezics:${property === 'wdt:P725' ? 'voiceActorOf' : 'authorOf'}`,
  sourceTypes: ['schema:Movie'],
  targetTypes: ['schema:Person'],
  release: 'sha256:cast-release',
  qualifiers: [],
});
const links = (property: string, label: string) => ({
  links: [
    {
      subject: work,
      property,
      statement,
      type: 'schema:Movie',
      label,
      summary: { labels: { en: label }, types: ['schema:Movie'] },
    },
  ],
  count: { value: 1, exact: true },
  next: null,
});

function render(directions: ReleasedRelationDirectionResult[]) {
  const plan = planReads(platformRegistry, document, { subject: person });
  const reads = Object.fromEntries(
    Object.entries(plan.reads).flatMap(([key, read]) =>
      read.kind === 'links'
        ? [
            [
              key,
              { status: 200, body: links(read.property, read.property === 'wdt:P725' ? 'Voice role' : 'Book credit') },
            ],
          ]
        : [],
    ),
  );
  return renderToString(
    h(
      PageData,
      { locale: 'en', subject: person, document, reads, messages, directions },
      h(CompositionRender, {
        document,
        definitions: pageDefinitions,
        components: { ...layoutComponents, ...dataComponents },
        root: PageRoot,
      } as never),
    ),
  );
}

test('Person pages keep voice credits separate and unavailable inverse admission distinct from complete empty', () => {
  const admitted = render([direction('schema:author'), direction('wdt:P725')]);
  expect(admitted).toContain('General contributions');
  expect(admitted).toContain('Voice credits');
  expect(admitted).toContain('Book credit');
  expect(admitted).toContain('Voice role');

  const missingVoiceDirection = render([direction('schema:author')]);
  expect(missingVoiceDirection).toContain('Book credit');
  expect(missingVoiceDirection).toMatch(/id="voice"[^>]*data-state="failed"/);
  expect(missingVoiceDirection).not.toMatch(/id="voice"[^>]*data-state="empty"/);
});
