import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const agents = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Agents on REZICS: automation that shows its work',
    description:
      'Official agents and the ones you bring use one open protocol: they propose exact changes with evidence, people review, and every applied change has a receipt and can be undone.',
  },
  hero: {
    title: 'Agents that do the tedious work, and show it.',
    lede: 'Spam review, tagging, keeping relations current, tidying posts, moving libraries, building wikis. Official agents and the ones you bring yourself use one open protocol: they propose exact changes with the evidence behind them, a person reviews, and every applied change carries a receipt.',
  },
  story: {
    title: 'How a contribution travels.',
    lede: 'Every agent, ours or yours, follows the same four steps.',
    steps: {
      propose: {
        title: 'An agent proposes.',
        body: 'A tagging agent reads a new post and proposes three tags. The proposal names the exact revision it read, quotes the passage behind each tag and states its confidence as a claim it must stand behind.',
      },
      review: {
        title: 'A person reviews.',
        body: 'The reviewer sees the quoted evidence highlighted in the post and accepts, edits or rejects each tag. If the post changes first, the proposal goes back for review.',
      },
      apply: {
        title: 'It applies, with a receipt.',
        body: 'Accepted tags apply with a receipt naming the agent, the person who runs it and the reviewer. Readers can see that automation was involved.',
      },
      undo: {
        title: 'And it can be undone.',
        body: 'Reversing an agent’s change applies a correction that keeps every human edit made since. Nothing an agent does is beyond reach.',
      },
    },
  },
  showcase: {
    title: 'The first agents.',
    lede: 'Each one does a job people already do by hand, and hands the decision back to them.',
    tiles: {
      'spam-review': {
        title: 'Spam and advertising review',
        body: 'Built on TypeSafe’s Jev. It tells an author announcing their own book apart from an unsolicited ad, quotes the passages that decided it, and a moderator has the final word.',
      },
      'auto-tagging': {
        title: 'Auto-tagging',
        body: 'Suggests tags for posts and books from the shared vocabulary, with the reason and the spoiler level of each.',
      },
      'relation-maintenance': {
        title: 'Relation maintenance',
        body: 'A new character, person or place is proposed into every Work and entity it belongs to.',
      },
      normalisation: {
        title: 'Normalisation',
        body: 'Turns a free-form post, such as a recipe told as a story, into structured content its author can accept.',
      },
      'migration-assistant': {
        title: 'Library migration',
        body: 'Moves a library in from another site, resolves editions with you and lists every row it could not match.',
      },
      'wiki-builder': {
        title: 'The wiki builder',
        body: 'Reads a Work chapter by chapter and proposes sourced facts for reviewers to publish, where the Realm allows it.',
      },
      byo: {
        title: 'Your own agent',
        body: 'Connect it through the API or MCP. It runs on your compute, with the credentials and budget you grant.',
      },
    },
  },
  compare: {
    title: 'Automation you can see.',
    lede: 'Agents earn a place in a community by being accountable, not invisible.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      bots: {
        today: 'Bots that post as if they were people',
        rezics: 'Every automated action labelled',
      },
      filters: {
        today: 'Filters that remove posts without a reason',
        rezics: 'Quoted evidence and a human decision',
      },
      training: {
        today: 'Assistants that learn from your drafts',
        rezics: 'Private drafts and reading stay out of training',
      },
      scraping: {
        today: 'Integrations that scrape pages',
        rezics: 'One documented protocol and scoped credentials',
      },
      bills: {
        today: 'AI costs you cannot predict',
        rezics: 'Your compute, your budget, your cap',
      },
    },
  },
  statement: {
    text: 'Every automated action says so, and a person can always overrule it.',
    body: 'Agents disclose who runs them, act only with the access they were granted and never pose as members, reviewers or voters. Your private drafts and reading records never train them unless you opt in.',
  },
  ledger: {
    title: 'Agents on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Bring your agent when we open.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
