# Frontend delivery and acceptance

Implement shared React surfaces over qualified domain APIs and generated clients.
Account login, per-task Agent context, Main Version reading/creation, Space
management, contextual classification/ratings, graph/text discovery and package
planning must preserve the same backend semantics. Client state is not authority.

Use React with vinext's Next.js-compatible App Router on Vite, deployed to
Cloudflare Workers. This matches the maintainer's Workers/Vite deployment choice;
it supersedes the earlier React Router recommendation. Keep domain commands in
Elysia Main on Bun; the Workers frontend hosts rendering, sessions and the web BFF.
Yarn manages both workspaces without implying one runtime for both deployments.

The [stack comparison](../research/application-stack.md#frontend-options) records
current versions and vinext's compatibility gaps. Native Next.js supports
self-hosting and is a valid alternative when the deployment/build requirements
change; platform lock-in is not the reason to reject it here. The old repository's
vinext implementation supplies patterns to inspect, not an old-system compatibility
requirement or completed acceptance of this new application.

Qualify SSR/RSC rendering, auth redirects/cookies, private cache isolation,
locale/authority variation, explicit public revalidation, editor bundling and
Storybook on the pinned Workers build. Do not assume full Cache Components/PPR
parity or reuse Node-only media processing in Workers. Image transformation belongs
to an admitted service or platform adapter. Plain request-scoped/private rendering
does not depend on incomplete shared-cache features. Browser/rendered acceptance
continues under the authorization rules below.

Ordinary users see the common entry, selected context and useful defaults; advanced
controls preserve all saved meaning. Show pending/stale/partial/unavailable states,
retain recoverable input and never silently replace an exact selection. Material
consent, installation effects and rights changes remain visible.

Affected workspace TypeScript/deterministic checks and scoped Storybook browser
tests with actual screenshot review qualify changed components at verification.
Full-application browser/rendered/responsive QA requires an explicit request for
that task. Component acceptance does not prove human usability or whole-system
capacity. [Experience contracts](../experience/README.md) own journeys and cases.
