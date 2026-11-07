import { expect, test } from 'bun:test';
import { composeContentApplication } from '../../src/composition/content.ts';
import { tryFeedCapabilities, unbindContentApplication } from '../../src/content/adapters/index.ts';
import { bindContentApplication, tryContentApplication } from '../../src/content/adapters/bind.ts';

test('default composition binds Continue, public summary and presentation producers before IO', () => {
  const previous = tryContentApplication();
  try {
    unbindContentApplication();
    expect(tryFeedCapabilities()).toBeUndefined();
    composeContentApplication();
    const bound = tryFeedCapabilities();
    expect(bound?.createContinuation).toBeFunction();
    expect(bound?.createPublicSummary).toBeFunction();
    expect(bound?.present({ subjectId: 'x', state: null, lastActivityAt: 't', activeProgressSession: null })).toEqual({
      subjectId: 'x',
      state: null,
      lastActivityAt: 't',
      activeProgressSession: null,
    });
  } finally {
    unbindContentApplication();
    if (previous) {
      bindContentApplication(previous);
      composeContentApplication();
    }
  }
});
