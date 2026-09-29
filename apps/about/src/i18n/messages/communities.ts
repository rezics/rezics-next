import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const communities = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Realms on REZICS: communities that keep what they learn',
    description:
      'Realms gather people around one story, one language or one idea, with rules in every language, a wiki that keeps what the conversation discovers and moderation you can follow.',
  },
  hero: {
    title: 'Conversations that become knowledge.',
    lede: 'A Realm gathers people around one story, one language or one idea. Its discussions sit beside the wiki that keeps what they discover, its rules are stated in every language it speaks, and its moderation is visible to the people it affects.',
  },
  story: {
    title: 'A Realm, from its first post to its hundredth page.',
    lede: 'Communities grow in steps. Each one should leave something behind.',
    steps: {
      found: {
        title: 'Found it with rules people can read.',
        body: 'State the rules once in each language the Realm speaks. Moderators apply the same rules to everyone.',
      },
      gather: {
        title: 'Follow to read along, join to take part.',
        body: 'Readers can follow quietly; members post, reply and review. Nobody wonders which one they signed up for.',
      },
      keep: {
        title: 'Keep what the conversation finds.',
        body: 'A theory confirmed in chapter 30 becomes a sourced fact on the Realm’s wiki, linked back to the thread where it started.',
      },
      protect: {
        title: 'Protect it without silencing it.',
        body: 'Newcomers start with gentle limits that lift as they take part. Reports become cases with a reason and an appeal.',
      },
    },
  },
  showcase: {
    title: 'A community that remembers.',
    lede: 'Chat scrolls away. A Realm keeps its history and its knowledge.',
    tiles: {
      languages: {
        title: 'Many languages, one Realm',
        body: 'Post in the language you think in; others read in theirs.',
      },
      wiki: {
        title: 'A wiki that belongs to the Realm',
        body: 'The Realm decides what its wiki says and whether agents may help.',
      },
      recognition: {
        title: 'Recognition for real help',
        body: 'Levels from accepted contributions, never from streaks.',
      },
      cases: {
        title: 'Moderation you can follow',
        body: 'Every decision with its reason, every case with an appeal.',
      },
    },
  },
  compare: {
    title: 'Community without the churn.',
    lede: 'The best answers in a community should still be findable next year.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      scroll: {
        today: 'Answers that scroll away in chat',
        rezics: 'Discussion that feeds a sourced wiki',
      },
      owner: {
        today: 'Rules in one language, applied unevenly',
        rezics: 'Rules in every language, applied to everyone',
      },
      removals: {
        today: 'Removals without a reason',
        rezics: 'A stated reason and a way to appeal',
      },
      farming: {
        today: 'Points for showing up every day',
        rezics: 'Recognition for contributions others accepted',
      },
    },
  },
  statement: {
    text: 'Every Realm keeps what it learns.',
    body: 'Discussion, wiki and moderation live together, so a community’s knowledge outlasts any single thread.',
  },
  ledger: {
    title: 'Realms on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Found your Realm when we open.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
