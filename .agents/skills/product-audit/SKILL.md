---
name: product-audit
description: Find class-level product problems in REZICS before users do. Use at each milestone, before calling an area complete, and whenever one defect is reported, to find every surface that breaks the same principle.
---

# Product audit

A reported defect is usually one instance of a broken principle. The earlier
"natively multilingual" failure was one: two stored languages, glued names and a
checker that counted missing keys without failing all came from the same gap.
This method finds the class, fixes it and makes code prevent it from returning.

## 1. Pick jobs, not pages

Choose the people and programs REZICS serves: returning reader, writer,
catalogue editor, moderator, newcomer, operator and an integrating agent. Give
each a concrete outcome ("resume yesterday's book", "correct an author credit")
with device, language, identity and authority. Treat these as hypotheses until
real users confirm them.

## 2. Walk the whole journey, twice

Discover, understand, act, get confirmation, return, recover, leave or export.
Walk it once through the API (HTTP, SDK or MCP) and once through the UI. The API
is the complete experience; the UI simulates it for people. A job that only the
UI can finish, or only the API, is a gap. Note every owner hand-off (Account to
Main, writer to moderator).

At each step ask: will the person pursue the right subgoal, notice the action,
understand its effect and see progress? For a program: can it discover the
operation, its schema, its authority and a machine-readable outcome?

## 3. Cross every journey with adverse states

Empty, loading, unavailable, denied, expired identity, concurrent edit, retry
after a lost response, offline, deleted target, a large inventory (more than any
page or sample size), right-to-left and mixed scripts, a content language that
is not one of the eight UI locales, and every age and region rule.

## 4. Compare by identical task

Benchmark the same task on the best product for it (GitHub, Reddit, Fandom,
Notion, Goodreads, AO3, VNDB, Bangumi and the field's leaders), including their
failure and return paths. Count outcomes, not features.

## 5. Trace each finding through the stack

Model, command, read, client. Check pagination, idempotency, authority,
preservation of fields the client did not send, and whether a request bound has
quietly become a product limit.

## 6. Cluster by broken invariant, then prioritise

Group findings under the principle they break. Recurring classes in REZICS:

- meaning lost at an adapter (a quick edit clears dates; UI locale used as
  content language; policy encoded in titles);
- a request bound treated as the product (sampled windows presented as the
  catalogue);
- a capability that exists in the API with no journey, or a journey that the
  API cannot complete;
- one policy applied differently on different surfaces (privacy, blocking,
  ratings, moderation jurisdiction);
- checks that pass while the invariant fails.

Order: irreversible loss, safety and disclosure; blocked core jobs; repeated
friction; differentiation. Record evidence, affected surfaces and a falsifying
acceptance scenario for each class.

## 7. Fix the class and make code guard it

Fix every instance of the class, not the reported one. Then add the guard that
fails when it returns: a lint rule, a schema constraint, a generator, a test over
all routes or catalogues, a check in `task check`. A principle that only lives in
a document will be broken again.

## Output

A ranked backlog of classes, each with its instances (file paths), API flow, UI
flow, the guard that will prevent recurrence and what not to do. Keep evidence
and inference separate; static reading does not establish human task success.
