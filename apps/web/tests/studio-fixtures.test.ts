import { expect, test } from 'bun:test';
import { ids, storyMain } from '../features/studio/fixtures.ts';

test('Studio story reruns restore seeded heads and independently copied outlines', () => {
  const story = storyMain();
  const head = story.seed(ids.texts.story, 'Opening.', 'en', ids.story);
  story.seedBook(ids.serial, [{ target: ids.chapters[0]!, title: 'Opening' }]);
  story.reset();
  story.writeElsewhere(ids.texts.story, 'Changed.');
  story.book(ids.serial)!.nodes[0]!.label!.value = 'Changed';
  story.calls.push('edit');
  story.reset();
  expect(story.head(ids.texts.story)).toBe(head);
  expect(story.book(ids.serial)!.nodes[0]!.label!.value).toBe('Opening');
  expect(story.calls).toEqual([]);
  story.book(ids.serial)!.nodes[0]!.label!.value = 'Changed again';
  story.reset();
  expect(story.book(ids.serial)!.nodes[0]!.label!.value).toBe('Opening');
});
