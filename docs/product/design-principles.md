# Product, API and GUI design principles

The intent behind REZICS capabilities, APIs and screens. The
[API/UI design skill](../../.agents/skills/api-ui-design/SKILL.md) supplies the
methods and sources; feature code, stories and tests carry concrete decisions,
and the [frontend direction](../plan/frontend.md) records the current Goal's.

Judge each statement as what it is: a contract is a required outcome (server
authorization, preserved saved state), a default guides tradeoffs (common tasks
first), a hypothesis proposes a way (a layout). Current instructions and real
constraints win; an adopted change goes to its owner.

1. **Start from the task.** What people and integrating clients need to
   accomplish defines the product. Current tables, endpoints, screens and
   familiar patterns are evidence, not the definition. Label inferred needs.
2. **One capability, every client.** GUI, SDK, MCP and other permitted clients
   share business semantics and server-enforced policy, so no client recreates
   authorization or loses meaning. An API is not a database dump: domain
   commands and purpose-specific reads may simplify client work. Each
   user-facing capability needs a usable path, not a control per endpoint.
3. **Ordinary use direct, advanced use discoverable.** The maintainer
   prioritizes the roughly 90% of people who are ordinary users (a priority,
   not a measured share): useful defaults and task-focused first screens;
   advanced capabilities stay one clear, contextual step away.
4. **Preserve meaning.** Presets and advanced controls configure the same
   capability. Identity, cardinality, operators, ordering, scope, missing values
   and partial or failed outcomes survive every surface. An ordinary edit keeps
   advanced state created elsewhere; a surface that cannot edit it safely shows
   a summary and routes to a capable editor, because silently flattened state
   destroys work people cannot see.
5. **Keep material consequences visible.** Show identity, authority, affected
   scope and outcome when they matter to the action. Consent, destructive
   consequences, restrictions and privacy never hide under advanced disclosure;
   protocol detail stays in developer or diagnostic surfaces. Recoverable
   failures keep input and offer a next step.
6. **Validate adopted and original ideas alike.** Neither a missing precedent
   disqualifies an idea nor popularity qualifies it; follow
   [research and validation](../../.agents/skills/research-and-validation/SKILL.md).
   API tests do not establish usability, and screenshots do not establish human
   task success. Revisit a default when ordinary tasks need advanced concepts.
