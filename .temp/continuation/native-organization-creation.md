---
{
  'goal': 'accounts',
  'manager': 'accounts',
  'kind': 'implementation',
  'paths':
    [
      'services/auth/src/organization-creation-page.ts',
      'services/auth/src/host.ts',
      'services/auth/test/organization-creation-page.test.ts',
      'services/kernel/src/access/organization-creation-page-source.ts',
      'services/kernel/src/access/native-account-bindings.ts',
      'services/kernel/test/access/organization-creation-page.test.ts',
      'apps/auth/src/organization-creation-page.ts',
      'apps/auth/src/routes/organizations.new.tsx',
      'apps/auth/tests/organization-creation-page.test.ts',
      'apps/auth/src/stories/accounts-operations/organizations/organizations.stories.tsx',
      'apps/auth/messages/*.json',
      'apps/auth/README.md',
      'apps/auth/tests/organization-create.test.tsx',
      'apps/auth/tests/organization-create-departure.test.tsx',
    ],
  'riskAreas': ['authorization', 'account', 'disclosure'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 2000, 'files': 18 },
  'acceptance':
    {
      'tests':
        [
          'bun test services/auth/test/organization-creation-page.test.ts',
          'bun run --cwd services/kernel check test/access/organization-creation-page.test.ts',
          'bun test apps/auth/tests/organization-creation-page.test.ts apps/auth/tests/organization-create.test.tsx apps/auth/tests/organization-create-departure.test.tsx',
        ],
    },
}
---

# Finish native organization creation readiness

A signed-in person opening New organization must recognize the acting human, review handle rules and initial ownership consequences, see current native creation advice, complete existing step-up when needed, explicitly confirm the retained operation and reach the created organization's supported member-management destination. Ordinary browser session scopes alone must never enable Create.

The retained route now preserves unknown creation across later approval refusal, platform closure, unavailable responses, authentication return and account/session loss. It retains the original key/handle and departure protection, retires stale callbacks, refuses missing/replaced continuation storage, and shows a localized unresolved notice alongside current restrictions. A known first mounted refusal releases its own continuation; restored hints, including submitted:false, remain conservative. Keep this recovery and the updated tests. No native creation-page port or response exists yet; this is the remaining product work.

Read the current Accounts decisions and M1 directive named by the original contract, docs/development/agent-conduct.md and applicable Auth/Access owner contracts. Current ordinary-session organization form and native command/approval producers remain unchanged except for recovery. Reference inspection found no corresponding organization creation surface in legacy-final; personal-info.tsx supports attached feedback and visible pending states. The read-only earlier app's features/participation/components/organization-membership-manager.tsx supplies supported named management navigation and retry/error presentation, not organization creation policy. Read the linked automated-creation-page-currentness decision for trusted composition.

Add a narrow read-only Auth organization-creation-page port, actual registered host route and real native-account-bindings capability. Reuse the installed organization:create action at PLATFORM_RESOURCE.id with global target kind and the same active, unoperated human basis, credential floor/fence, assignments, grants and exposure predicates as workflow-approvals.ts. Readiness is not a grant. Keep native-creation-context.ts approved-operation provenance and durable workflow ports unchanged. Do not create approvals, reservations, accounts, credentials or grants while loading advice.

Use a deferred accessTokenForProof callback; never call config.auth() during construction. Revalidate the exact scoped Auth proof before and after native I/O, within one finite deadline; unchanged Access snapshots do not prove Auth liveness. Exercise construction without callback invocation and actual registered-host session removal/replacement during native I/O. Missing capability and failed dependencies yield unavailable, never fabricated denial or platform closure. Ordinary sessions disclose only independently admitted self presentation and supported authentication preparation, never an allowed create check they cannot perform. Return a closed projection with recognizable self presentation and fallback, current viewer advice, existing command handle rules, initial-owner consequences and supported native action states. Exclude proofs, tokens, email/private account data, approval capabilities and internal evidence. Document the static summed preparations/checks, full-key seeks and presentation lookups; no scans, action fanout or price/consent protocol.

Consume that response through the organization page adapter and existing form. Refresh advice and retire controls on account, session/CSRF or observation change without settling earlier unknown execution. Keep handle errors attached/focused, pending/error/retry states accessible and all eight locales complete. Preserve shared normalizeSignupHandle and all command-time approval/fresh-human/grant/exposure checks, atomic initial owner/reservation writer and real producers. Do not edit account-operations.ts (personal-deletion owns it); retain uncertainty at its existing boundary. Authentication return restores the exact review and requires explicit confirmation. Never treat matching public handles or empty management lists as noncommit, or create a status oracle. Creation acknowledgement links to existing authorized membership management without claiming independently proven current ownership.

Add focused native/host and interface scenarios for allowed, ordinary/step-up, unrelated/operated actor, stale floor, fence, closure, refusal, dependency failure and observation/submit races. Cover actual producer creation, exact handle/key return, unknown retry, account replacement, replacement continuation surviving late completion, and lost execution followed by approval denial/closure. Preserve the existing recovery regressions. Test additions stay fewer changed lines than product. Stories cover named states only. Native/browser acceptance remains subject to the controller's current integration policy; when authorized, capture form/result/refusal at 390/1440, light/dark, zh-Hant/ja with concrete revision/build, fixture and producer provenance under .temp/. No M1 or whole-Goal pass claim from focused checks.
