import type { CaseDeclarations } from './declaration.ts';

const integration = 'tests/qa/integration/g-704-contribution-loop.test.ts';
const e2e = 'apps/web/tests/g-704-contribution-loop.e2e.ts';

const correctionApi = 'CLP01/CLP04: a correction in a non-UI language is proposed, reviewed, revised, decided, notified, withdrawn and reverted';
const correctionBrowser = 'CLP01/CLP04: a contributor proposes, is asked for changes, revises past a stale approval, and sees the decision and its revert';
const bundleApi = 'CLP02/CLP04: an assistant proposes a wiki bundle, reviewers revise and decide it, and everyone concerned is notified';
const bundleBrowser = 'CLP02/CLP04: a steward reviews an assistant’s wiki bundle, sees an approval stop counting, and publishes it';
const deltaApi = 'CLP03/CLP04: a chapter delta retracts one claim without deleting what it omits, resumes after interruption and reverts';
const historyBrowser = 'CLP03/CLP05/CLP06: a chapter delta is reviewed and reverted in the browser, a pin and an export outlive it, and a revoked assistant keeps its work';
const historyApi = 'CLP05: historical wiki rendering and export survive renames, merges and rights changes';
const credentialApi = 'CLP06: a replaced or revoked assistant credential keeps the artifacts it was authorized to make';
const closedApi = 'CLP07: the public API has no operation for the capabilities M7 keeps closed';
const closedBrowser = 'CLP07: the site offers no way into what M7 keeps closed';

/** M7 contribution-loop exit. One row per test title that carries the case ID. */
export const contributionLoopCases: CaseDeclarations = {
  CLP01: [
    { tier: 'integration', file: integration, name: correctionApi },
    { tier: 'e2e', file: e2e, name: correctionBrowser },
  ],
  CLP02: [
    { tier: 'integration', file: integration, name: bundleApi },
    { tier: 'e2e', file: e2e, name: bundleBrowser },
  ],
  CLP03: [
    { tier: 'integration', file: integration, name: deltaApi },
    { tier: 'e2e', file: e2e, name: historyBrowser },
  ],
  CLP04: [
    { tier: 'integration', file: integration, name: correctionApi },
    { tier: 'integration', file: integration, name: bundleApi },
    { tier: 'integration', file: integration, name: deltaApi },
    { tier: 'e2e', file: e2e, name: correctionBrowser },
    { tier: 'e2e', file: e2e, name: bundleBrowser },
  ],
  CLP05: [
    { tier: 'integration', file: integration, name: historyApi },
    { tier: 'e2e', file: e2e, name: historyBrowser },
  ],
  CLP06: [
    { tier: 'integration', file: integration, name: credentialApi },
    { tier: 'e2e', file: e2e, name: historyBrowser },
  ],
  CLP07: [
    { tier: 'integration', file: integration, name: closedApi },
    { tier: 'e2e', file: e2e, name: closedBrowser },
  ],
};
