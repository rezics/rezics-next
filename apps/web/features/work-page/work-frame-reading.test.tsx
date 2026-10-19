import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { projectionFor } from '../entity-page/fixtures.ts';
import { globalRatings, work } from './fixtures.ts';
import { messages } from './messages.ts';
import { idOf, workHref } from './route.ts';
import { WorkFrame } from './work-frame.tsx';
import { WorkFrameView } from './work-views.tsx';

seedServedTypes();
const id = idOf(work.id)!;
const projection = projectionFor({ id, base: 'work', types: work.types, name: work.title.value });
const ratings = globalRatings.ok ? globalRatings.data : null;
if (!ratings) throw new Error('The public rating fixture must have a question');

for (const signedIn of [false, true]) {
  test(`${signedIn ? 'a signed-in rating editor keeps its exact target' : 'anonymous Work navigation does not wait for the public rating read'}`, async () => {
    const ratingStarted = Promise.withResolvers<void>();
    const ratingAnswer = Promise.withResolvers<void>();
    const fetcher = Object.assign(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/page')) return Response.json(projection);
      if (path.endsWith('/rating-contexts')) {
        ratingStarted.resolve();
        await ratingAnswer.promise;
        return Response.json({ profile: 'rating-context-page-v1', items: ratings.contexts, nextCursor: null });
      }
      if (path.endsWith('/ratings')) return Response.json(ratings.summary);
      return Response.json({ title: 'Read unavailable' }, { status: 503 });
    }, { preconnect: fetch.preconnect });
    const anonymous = browserMainApi('https://work-reading.invalid', { anonymous: true, fetcher });
    const pending = WorkFrameView({ workRef: id, id, work, locale: 'en', messages: messages.en,
      client: { main: anonymous, anonymous, signedIn, pageUrl: `https://work-reading.invalid${workHref(id)}` },
      children: <p>Connections</p> });
    let ready = false;
    void pending.then(() => { ready = true; });
    try {
      await ratingStarted.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(ready).toBe(!signedIn);
    } finally {
      ratingAnswer.resolve();
    }
    const frame = await pending;
    expect(frame.type).toBe(WorkFrame);
    expect(frame.props.signedIn).toBe(signedIn);
    expect(frame.props.ratingTarget).toEqual(signedIn ? {
      work: work.id, context: ratings.context!.context, mainVersion: work.mainVersion, max: ratings.context!.scale.max,
    } : null);
    expect(frame.props.ratingLine).toBeDefined();
  });
}
