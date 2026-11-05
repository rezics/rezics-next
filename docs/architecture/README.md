# Architecture check

Decision: Keep the current workspace and capability boundaries, assign each module to its documented Goal owner, and snapshot existing imports as explicit dependencies while grandfathering their violations for gradual removal.

Decision: Register Access, Bounds, and Operations as pure core modules with only their exported package entries; grant dependencies to the concrete Kernel adapter modules that actually import them, and keep native implementation choice in composition roots.

`modules.json` assigns the production sources in Kernel, Auth, Importer, Web, and the runtime packages to one module each. Tests, stories, fixtures, and workspace configuration are not production source roots. Each module records its kind, owner Goal, registered capabilities, public entries, and current allowed module dependencies. Kernel foundation code with no product owner is assigned to `platform`.

The checker enforces source coverage, public entry imports (including type-only edges), module dependency direction and cycles, new value-import cycles, pure core and contract imports, adapter SQL ownership, package isolation from apps and services, and ratchet integrity. Current violations are grouped by source module in `boundary-baseline.json` with the module owner and reason `pre-boundary code`. A disappearing entry is reported so the group can be reduced.

## Parser and runtime

The check uses Bun's transpiler import scan for value dependencies and a code-aware lexical pass to retain type-only imports and source locations. It does not execute modules. Relative paths, package exports, workspace path aliases, and declaration-file fallbacks are resolved; conditional workspace exports are combined across their declared targets. SQL files are graph targets but are not parsed as TypeScript.

The full graph is cached under `.temp/architecture/graph.json`. `--changed <files...>` hashes the production roots, reparses only the listed changed files, and checks those edges against the complete cached graph. If the changed list is incomplete or the manifest or resolution configuration changed, the command asks for a fresh full scan.

## Commands and exit codes

| Command                                            | Purpose                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `bun scripts/architecture.ts`                      | Validate the manifest, current graph, and baseline; refresh the graph cache. |
| `bun scripts/architecture.ts --changed <files...>` | Recheck changed source edges against the cached complete graph.              |
| `bun scripts/architecture.ts --map`                | Print the compact worker module map (maximum 2,000 characters).              |

Exit code `0` means the check passed, `1` means an architecture or manifest violation, and `2` means invalid CLI input, unavailable cache, or a tool/configuration failure. The full graph build and initial ratchet seeding took 14.7 seconds for 6,876 production files on this worktree. The full check is budgeted at under 30 seconds; cached changed checks at under 5 seconds. Landing acceptance will record command timings.
