import { defineEnglishCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const developers = defineEnglishCopy<LinePageCopy>({
  meta: {
    title: 'Developers on REZICS: the whole product as an API',
    description:
      'Every capability of REZICS is an API operation first: scoped credentials, errors your code can act on, safe retries, resumable events, a TypeScript SDK and MCP for agents.',
  },
  hero: {
    title: 'Build on the same REZICS people use.',
    lede: 'Every capability is an API operation first, and the website is one client among many. Your app, your script and your agent get the same operations, with credentials scoped to the job, outcomes they can read and retries that never do anything twice.',
  },
  story: {
    title: 'One task, done properly.',
    lede: 'Importing a library through the API, the way the website does it.',
    steps: {
      credential: {
        title: 'Ask for exactly what you need.',
        body: 'A credential scoped to one library and one task, revocable in one place.',
      },
      prepare: {
        title: 'Prepare, then review.',
        body: 'Upload the export and get a preview: matched editions, rows that need a choice and fields that will not carry over.',
      },
      apply: {
        title: 'Apply safely, even twice.',
        body: 'Send the decision with an idempotency key. A retry after a timeout returns the same receipt instead of a second import.',
      },
      follow: {
        title: 'Follow what happens next.',
        body: 'Read events with a durable cursor and resume exactly where you left off after a disconnect.',
      },
    },
  },
  showcase: {
    title: 'What you build with.',
    lede: 'The pieces that make an integration dependable.',
    tiles: {
      errors: {
        title: 'Errors your code can act on',
        body: 'Problem details that name the cause and the next step.',
      },
      sdk: {
        title: 'A TypeScript SDK',
        body: 'Typed clients from the same definitions as the API.',
      },
      mcp: {
        title: 'MCP for agents',
        body: 'Agents connect with the same scopes and budgets as apps.',
      },
      portal: {
        title: 'Docs that cannot drift',
        body: 'Generated from the registry the API runs on.',
      },
    },
  },
  compare: {
    title: 'An API that is the product, not an afterthought.',
    lede: 'Integrations should not have to reverse-engineer a website.',
    today: 'Today',
    rezics: 'On REZICS',
    rows: {
      scraping: {
        today: 'Scraping pages because there is no API',
        rezics: 'Every capability documented as an operation',
      },
      tokens: {
        today: 'One token that can do everything',
        rezics: 'Credentials scoped to resources and tasks',
      },
      retries: {
        today: 'Retries that create duplicates',
        rezics: 'Idempotent operations with receipts',
      },
      success: {
        today: 'A 200 that quietly dropped your fields',
        rezics: 'Outcomes that say exactly what was kept',
      },
    },
  },
  statement: {
    text: 'If a person can do it on REZICS, your code can too.',
    body: 'The same operations, the same permissions and the same outcomes, whether a click or a call starts them.',
  },
  ledger: {
    title: 'Developers on REZICS',
    lede: 'Each capability shows where it stands today.',
  },
  cta: {
    title: 'Get your first credential on day one.',
    body: 'Leave your email and we will write once, when registration opens.',
  },
});
