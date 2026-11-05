import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SubjectHeaderActions } from '../../src/features/pages/subject-reactions-view';
import { setLocale, type Locale } from '../../src/paraglide/runtime.js';
import { ThreadPostActions, ThreadReactions } from '../../src/threads/thread-reactions';

const query = new URLSearchParams(window.location.search);
const locale = query.get('locale') ?? 'en';
const signedIn = query.get('signedIn') !== 'false';
const allSubjectReactions = query.get('full') === 'true';
const subjectCounts = allSubjectReactions ? { like: 9, love: 8, laugh: 7, insightful: 6, sad: 5 } : {};
const threadCounts = { upvote: 9, downvote: 8, like: 7, love: 6, laugh: 5, insightful: 4, sad: 3 };

function ReactionLayout() {
  useEffect(() => {
    document.documentElement.dataset.reactionHarness = 'ready';
    document.documentElement.dataset.hydrated = '';
  }, []);

  return (
    <main className="mx-auto min-w-0 max-w-5xl p-4">
      <header
        className="grid min-w-0 grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]"
        data-slot="subject-overview-header"
      >
        <div className="min-w-0">
          <h1 className="font-serif text-3xl font-semibold">A subject with reactions</h1>
        </div>
        <SubjectHeaderActions
          id="subject-1"
          reactions={{ counts: subjectCounts, value: allSubjectReactions && signedIn ? 'sad' : null }}
          returnTo={`/${locale}/subjects/subject-1`}
          signedIn={signedIn}
          verification={{ sitekey: 'test-key', scriptUrl: '/turnstile.js' }}
        />
      </header>
      <section aria-label="Thread post" className="mt-12 min-w-0 max-w-full">
        <h2 className="text-xl font-semibold">A post with reactions</h2>
        <ThreadPostActions>
          <ThreadReactions
            counts={threadCounts}
            returnTo={`/${locale}/threads/thread-1`}
            signedIn={signedIn}
            target={{ kind: 'post', id: 'post-1' }}
            value={signedIn ? 'sad' : null}
          />
        </ThreadPostActions>
      </section>
    </main>
  );
}

await setLocale(locale as Locale, { reload: false });
document.documentElement.lang = locale;
createRoot(document.getElementById('root')!).render(<ReactionLayout />);
