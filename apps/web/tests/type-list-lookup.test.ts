import { expect, test } from 'bun:test';
import { findTypeList } from '../src/features/pages/type-list-model';
import type { PageDocument } from '../src/features/pages/render';

const list = (id: string) => ({
  type: 'TypeList',
  props: { id, title: { en: id }, types: ['schema:Book'], sort: 'name', limit: 12 },
});
const page = (content: unknown): PageDocument => ({ root: { props: {} }, content }) as PageDocument;

test('lookup skips malformed and unsupported structure while keeping supported lists', () => {
  const kept = list('kept');
  const hidden = list('hidden');
  const document = page([
    null,
    { type: 'Stack' },
    { type: 'Unknown', props: { id: 'u', children: [hidden] } },
    { type: 'Heading', props: { id: 'h', text: 'x', level: 2, items: [hidden] } },
    { type: 'Stack', props: { id: 'broken', children: hidden } },
    { type: 'Stack', props: { id: 'empty' } },
    { type: 'Stack', props: { id: 'ok', gap: 'sm', children: [null, kept, list('later')] } },
  ]);
  expect(findTypeList(document, 'kept')).toEqual(kept);
  expect(findTypeList(document, 'later')?.props.id).toBe('later');
  expect(findTypeList(document, 'hidden')).toBeUndefined();
  expect(findTypeList(page({ type: 'TypeList', props: { id: 'root' } }), 'root')).toBeUndefined();
});
