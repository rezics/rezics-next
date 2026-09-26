# PKG07/PKG08 native loader probe

Run from the repository root:

```sh
bun tests/qa/fixtures/mod-native-oracle/run.ts
```

The runner checks the publisher SHA-256 sidecar for each loader JAR, then checks
every resolved Forge/NeoForge classpath JAR against `lock.json`. It runs the
published Fabric Loader 0.19.4 resolver, Forge FML 1.21.1-52.0.0 parser and
feature evaluator, and NeoForge FML 10.0.34 parser, feature evaluator and
conditional mixin gate inside the digest-pinned Java 21 Maven image. Downloads,
compiled classes and generated manifests stay under `.temp/mod-oracle/`.

The Fabric probe uses a native nested candidate linked to its parent declaration.
It does not perform archive extraction. Forge and NeoForge probes execute native
metadata and feature logic without launching Minecraft or applying mixin bytecode.
These observations qualify the bounded capture solver's side, embedded-child,
feature and conditional-mixin behavior; they do not certify full loader boot or
physical archive provenance.

Upstream behavior references: [Fabric Loader](https://github.com/FabricMC/fabric-loader),
[Forge mod files](https://docs.minecraftforge.net/en/latest/gettingstarted/modfiles/),
[NeoForge mod files](https://docs.neoforged.net/docs/gettingstarted/modfiles/).
