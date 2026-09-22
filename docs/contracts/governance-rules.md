# Governance rules and decisions

## Rule lifecycle

A rule has stable scope/identity and immutable semantic revisions, localized
presentation, activation interval, eligible decision makers and enforcement
capabilities. Draft, reviewed, active, superseded and retired are distinct.
Changing display translation must not alter the approved rule meaning.

Decisions cite exact rule revisions and evidence. Platform-wide minimum
restrictions remain distinct from Realm additions. Owner or Realm power does not
override protected account security or erase unrelated contexts. No API may infer
authority from a rule's title, tag or mere presence in a graph.

## Admission and review

Rule authoring, activation and enforcement are separately grantable. Bind previews
and approval to candidate digest and expected policy generation. Sensitive changes
require declared independent approval and grantability checks. Concurrent rule
activation serializes within its scope; old jobs recheck eligibility before apply.

AI review records method, input, model/tool configuration, limitations and observed
output; it is evidence under a selected policy, not an unrestricted administrator.
Ambiguous/unavailable review routes to explicit pending/human disposition.

## Persistence and capacity

Store rules, localized forms, decisions and exact anchors in Fluree. Access owns
effective security grants/fences. Staged enforcement and paged reverse impact
avoid full-corpus synchronous rewrites. Caches include rule and disclosure
generations; a retired rule does not retroactively change historical citations.

Test rule edits during decisions, localization drift, competing reversals,
independent approvers, source evidence changes and interrupted enforcement.
