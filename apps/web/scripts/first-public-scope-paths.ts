/** First-public-scope Web walk paths. The driver and capability table share this catalog. */
export const FIRST_PUBLIC_SCOPE_PATHS = [
  { id: 'W01', job: 'All public pages → localized shell → navigate on phone and desktop', auth: 'anonymous' },
  { id: 'W02', job: 'Public Subject → each released work, release and agent reader', auth: 'anonymous' },
  { id: 'W03', job: 'Subject → Editions → next native page → exact Edition → return', auth: 'anonymous' },
  { id: 'W04', job: 'Subject → Contents → next native page → child → return', auth: 'anonymous' },
  { id: 'W05', job: 'Subject → Cast → Character → return to the same cast page', auth: 'anonymous' },
  { id: 'W06', job: 'Subject → Crew → qualified Person or Organization credit → return', auth: 'anonymous' },
  { id: 'W07', job: 'Person or Character → credited works → exact work → multilingual return', auth: 'anonymous' },
  { id: 'W08', job: 'Subject → Relations or graph → exact related item → return', auth: 'anonymous' },
  { id: 'W09', job: 'Subject → Details → competing sourced facts → immutable history', auth: 'anonymous' },
  { id: 'W10', job: 'Public agent or handle → its single canonical profile and Subject', auth: 'anonymous' },
  { id: 'W11', job: 'Signed-out Home → native mixed public discovery → Subject', auth: 'anonymous' },
  {
    id: 'W12',
    job: 'Signed-in Home → Following or Continue item → act → return after session replacement',
    auth: 'signed-in',
  },
  {
    id: 'W13',
    job: 'Home → kind, exact Space and question Context selection → next or retry',
    auth: 'signed-in',
  },
  {
    id: 'W14',
    job: 'Library → profile or state shelf → bounded filters → Subject → return',
    auth: 'signed-in',
  },
  {
    id: 'W15',
    job: 'Library → private labels → create or edit → read back the same label',
    auth: 'signed-in',
  },
  {
    id: 'W16',
    job: 'New curated Collection → add or transfer occurrences → review exact members',
    auth: 'signed-in',
  },
  {
    id: 'W17',
    job: 'Built-in dynamic Collection → filters → native continuation → Subject',
    auth: 'signed-in',
  },
  {
    id: 'W18',
    job: 'Owned Collection → explicit publication → anonymous public reader and ItemList',
    auth: 'mixed',
  },
  {
    id: 'W19',
    job: 'Subject or Library → progress session → update → current readback and return',
    auth: 'signed-in',
  },
  {
    id: 'W20',
    job: 'Library → copies or holdings → edit → resolve newer reading → save and undo',
    auth: 'signed-in',
  },
  {
    id: 'W21',
    job: 'Following → bounded targets → inspect admitted destination → follow or stop → readback',
    auth: 'signed-in',
  },
  {
    id: 'W22',
    job: 'Private destination → sign-up or sign-in → safe return → sign-out',
    auth: 'signed-in',
  },
  {
    id: 'W23',
    job: 'Auth request → consent → approve or decline → current caller return',
    auth: 'signed-in',
  },
  {
    id: 'W24',
    job: 'Security settings → step-up → change credential → renewed session',
    auth: 'signed-in',
  },
  {
    id: 'W25',
    job: 'Settings → profile, reading or privacy preference → save → replacement or deletion recovery',
    auth: 'signed-in',
  },
  {
    id: 'W26',
    job: 'Admitted personal page → upload completion or download → current caller result',
    auth: 'signed-in',
  },
  {
    id: 'W27',
    job: 'Subject → admitted offer → checkout → payment return with authoritative fulfilment',
    auth: 'signed-in',
  },
  {
    id: 'W28',
    job: 'Orders or entitlements → captured fixed Edition → same-tab reader → exact detail return',
    auth: 'signed-in',
  },
  {
    id: 'W29',
    job: 'Board → thread → post or reply → current native conversation and history',
    auth: 'mixed',
  },
  {
    id: 'W30',
    job: 'Subject → Global standard rating or review → explicit write → current native readback',
    auth: 'signed-in',
  },
  {
    id: 'W31',
    job: 'Realm or Space → current public home → admitted membership or appearance action → readback',
    auth: 'mixed',
  },
  {
    id: 'W32',
    job: 'Readable content → report → owner resolution → affected-author receipt and appeal',
    auth: 'signed-in',
  },
  {
    id: 'W33',
    job: 'Signed-in Inbox → reply, mention or moderation notice → current destination and preference',
    auth: 'signed-in',
  },
  { id: 'W34', job: 'Configured static Zone address → localized routed page → native browser return', auth: 'anonymous' },
  {
    id: 'W35',
    job: 'Anonymous page → canonical, sharing and JSON-LD → robots and every eligible sitemap shard',
    auth: 'anonymous',
  },
] as const;

export type PathId = (typeof FIRST_PUBLIC_SCOPE_PATHS)[number]['id'];
export type PathAuth = (typeof FIRST_PUBLIC_SCOPE_PATHS)[number]['auth'];
export type PathStatus = 'PASS' | 'FAIL' | 'FAIL-unreached';
