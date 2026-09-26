# PKG07/PKG08 native loader probe

Run from the repository root:

```sh
bun tests/qa/fixtures/mod-native-oracle/run.ts
```

The runner checks the publisher SHA-256 sidecar for each loader JAR, then checks
every resolved Forge/NeoForge classpath JAR against `lock.json`. It runs the
published Fabric Loader 0.19.4 resolver and archive discoverer; Forge FML
1.21.1-52.0.0 parser, feature evaluator and full sorter; and NeoForge FML
10.0.34 parser, feature evaluator, full sorter and Mixin class processor inside
the digest-pinned Java 21 Maven image. Downloads, compiled classes and generated
manifests stay under `.temp/mod-oracle/`.

The Fabric probe physically builds a parent JAR containing a child JAR and checks
native discovery, then feeds those exact archive bytes to the capture solver and
compares the selected child and independent download. It also probes undeclared
paths, side filtering, provided IDs and alternative
ranges. Forge and NeoForge probes run `ModSorter.sort` with synthetic system mods,
including ordering cycles. Forge 52.0.0 logs a cycle then throws a
`NullPointerException` while constructing the loading list; NeoForge 10.0.34
logs a cycle then throws `ClassCastException` in its cycle error mapper. The
probe preserves both observations. NeoForge's Mixin processor applies a real `@Overwrite` to
target bytecode only when `requiredMods` is present. These observations qualify
the bounded capture solver; they do not certify full Minecraft startup.

The Fabric solver accepts a separate SHA-256 capture with surface `archive` for
each top-level parent. It verifies ZIP member bounds and CRC-32, matches the
parent's `fabric.mod.json`, extracts declared nested JARs and matches each child
manifest. A missing archive or entry is incomplete source data. Provided aliases
are accepted with wildcard requirements; alias version ranges remain unsupported
because native aliases do not inherit the provider's version as a simple range.

Upstream behavior references: [Fabric Loader](https://github.com/FabricMC/fabric-loader),
[Forge mod files](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/),
[NeoForge mod files](https://docs.neoforged.net/docs/gettingstarted/modfiles/).
