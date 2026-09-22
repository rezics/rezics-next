# Package runtime service

## Interfaces and ownership

Provide resolve/explain, lock, fetch/verify, plan, stage, activate, update, rollback,
remove and inspect-operation APIs. Main owns package/release/requirement facts.
Runtime owns recoverable execution state and installed environment inventory;
it records public results through Main's owning commands.

## Resolution

Bind requested environment, constraints, source snapshot and ecosystem profile.
Load candidates lazily through a cached provider interface. Dispatch generic
constraint problems to the selected Rust solver and ecosystem-specific behavior
to the appropriate adapter. Preserve feature/peer/instance scopes and actual
failure categories. Explanation records causes without exposing private packages.

## Installation

Build a plan with exact artifacts, digests, steps, declared effects, owned paths,
expected prior generation and rollback journal. Staging is isolated from active
environments. Only approved executors run hooks/builds with scoped filesystem,
network, secrets, time and resource limits. Nix evaluation and package scripts
are not treated as harmless metadata parsing.

Activation checks current authority, artifact eligibility and environment state.
Use a generation switch where available or a journaled adapter with explicit
partial/uncertain status. A cancelled worker cannot activate later. Remove owns
only declared paths and preserves user data. Keying by package name alone cannot
represent npm peers/nested versions or target-specific instances.

## Qualification

Compare contemporary Cargo/npm-family/Go/Nix/loader semantics on captured inputs.
Test no-solution explanations, source gaps, resource budget, path conflicts,
interrupted activation, lock replay, update and rollback. Hosted persistent
execution is a separately admitted deployment of this same controlled interface.
