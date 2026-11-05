import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../kernel/client';
import { readStoryArcProfile, storyArcUuid, type StoryArcAddress, type StoryArcRead } from './story-arc-profile';

export const loadStoryArcProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input: StoryArcAddress): StoryArcAddress => {
    if (
      !input ||
      [input.id, input.work].some((id) => id !== undefined && (typeof id !== 'string' || !storyArcUuid.test(id)))
    )
      throw new Error('Invalid story arc address');
    return { ...(input.id ? { id: input.id } : {}), ...(input.work ? { work: input.work } : {}) };
  })
  .handler(async ({ data }): Promise<StoryArcRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readStoryArcProfile(kernelClient(), data);
  });
