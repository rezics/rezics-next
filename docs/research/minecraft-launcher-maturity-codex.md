# Minecraft launcher maturity

## Recommendation

The common Windows x64 player journey is feasible with the current Electron shell and XMCL libraries. A mature
release lets a player choose a stable Minecraft and compatible loader version, sign in, install or import into an
isolated instance, play, manage content and worlds, and recover when installation or launch fails. The libraries
perform much of the Minecraft-specific work. REZICS must own the instance settings, durable operation state,
credential custody, process and log lifecycle, and the corresponding user experience. Qualification requires the
packaged app, licensed Minecraft Java accounts and the REZICS Microsoft application accepted by Minecraft Services.
These conditions are independent of work on the implementation. [Minecraft App ID review](https://aka.ms/mce-reviewappid) ·
[Microsoft public-client device authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)

Keep the feature in a first-party Launcher plugin that ships with the app. It contributes the Minecraft instance
form, account, settings, Mods, Worlds and Logs views. Its main-process service coordinates existing Minecraft and
Modrinth adapters. The Launcher host owns game process custody and the Overlay session. The shared save owner
supplies backup and restore to Minecraft and other games. The Kernel owns REZICS package publication and exact
release reads. Use the shared UI components and client transport at their normal entry points.

## Source findings

The references are local shallow clones under `.reference/launcher/`. Source was inspected at the listed revisions
without building or running the reference projects. Licence entries describe source packages checked at that revision.

| Clone       | Licence                   | What informed the design                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prism`     | GPL-3.0-only              | Chooses an account for the instance and checks ownership in the launch controller. Resolves components as a distinct task, executes a Java probe and determines which verified files a pack update should change. [Launch controller][prism-launch] · [Component updates][prism-components] · [Java checker][prism-java] · [Modrinth instance task][prism-pack] |
| `xmcl`      | MIT                       | Separates Java discovery and per-instance selection from downloads. The installer enforces loader-specific constraints. The launch service redacts access tokens and exposes lifecycle, crash context and process termination. [Install coordinator][xmcl-install] · [Launch service][xmcl-launch]                                                              |
| `xmcl-core` | MIT                       | Provides manifest resolution, game asset and library downloads, completion or diagnosis of interrupted installs, per-file Java verification and the process launch API. Check the installed package exports when adopting APIs from the newer source. [Complete installation][core-install] · [Java runtime][core-java]                                         |
| `modrinth`  | Modrinth App GPL-3.0-only | Separates pack installation from running profiles. Stages the import, hashes files and tracks downloads. The process owner collects output and the log API applies redaction. [Pack install][modrinth-pack] · [Process state][modrinth-process] · [Log API][modrinth-logs]                                                                                      |
| `packwiz`   | MIT                       | Exports a format version, exact game and loader dependencies, checked file records and client/server overrides. A pack thus carries a reproducible selection of inputs. [Pack export][packwiz-export]                                                                                                                                                           |
| `pcl2-ce`   | Apache-2.0                | The Chinese-facing launcher separates Java discovery, release and loader selection, checksummed downloads, and pack overrides. Import preserves a checklist that can surface progress and failure. [Java service][pcl-java] · [Download core][pcl-download] · [Pack import][pcl-pack]                                                                           |

Prism, XMCL and PCL Community Edition agree on versioned independent instances, compatible Java selection and
operator-visible repair. Prism, Modrinth App and PCL Community Edition make importing a real pack a different
journey from finding individual mods. Their provider coverage, scopes and install mechanics differ. Adopt one
reproducible pack format and support the ordinary Java player journey before copying additional format breadth.

Mojang's 1.6.4 profile passes the named virtual directory to the game. XMCL creates hard links there and keeps
existing destinations. Prism reads the asset index's `virtual` flag and copies downloaded objects under their
original names. REZICS checks the contents of these named files during preparation and Play, replacing stale
copies and hard links so changes to the virtual directory do not affect the download cache.
[Mojang 1.6.4 asset index](https://launchermeta.mojang.com/v1/packages/770572e819335b6c0a053f8378ad88eda189fc14/legacy.json) ·
[XMCL virtual assets](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/core/launch.ts#L249) ·
[Prism virtual assets](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/AssetsUtils.cpp#L196)

The Linux Java 25 manifest marks `lib/jspawnhelper` and the Java command-line tools executable and lists
links to the shared license files. The installed XMCL runtime task checks file contents but leaves executable
permissions to its caller. Its link attempt suppresses failures. Prism reports failures while laying out links
for a downloaded Java bundle. REZICS uses XMCL's verified downloads and applies the published runtime layout
before Java runs. Mojang's current Windows x64 manifests for Java 8, 17, 21 and 25 list regular files and
directories.
[Mojang Linux Java 25 manifest](https://piston-meta.mojang.com/v1/packages/0c16f58e591e144625a6d30a64e9314897f73a29/manifest.json) ·
[Mojang Windows x64 Java 25 manifest](https://piston-meta.mojang.com/v1/packages/b374544c680d965fb5535977d7cb04c6befe1930/manifest.json) ·
[XMCL runtime installer](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/installer/java-runtime.ts#L222) ·
[Prism Java link task](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/java/download/SymlinkTask.cpp#L44)

XMCL adds `repo1.maven.org` after the library profile URL. Maven's source defaults to `repo.maven.apache.org`,
and Sonatype supports both hosts over HTTPS. Both served the JSpecify bytes matching Mojang's 26.3 checksum.
The pinned XMCL 2.0.3 transfer library opens one output file for all candidate URLs. A loopback reproduction
left bytes from a longer failed response after overwriting it with a shorter, correct response. REZICS starts
a separate XMCL transfer for each source and publishes only the staged file that matches the profile checksum.
[XMCL library URL order](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/installer/libraries.ts#L139) ·
[Apache Maven central default](https://github.com/apache/maven/blob/5223074e77771a93a3670af95f2155fbde6f38f3/api/maven-api-core/src/main/java/org/apache/maven/api/Constants.java#L123) ·
[Sonatype TLS endpoints](https://central.sonatype.org/faq/ssl/)

Prism checks the instance's resolved Java path, detects whether the path came from an instance override, and
reports which setting the player can correct. The Launcher version-change checks use two Java majors to exercise
the original instance and its destination independently.
[Prism Java check](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/launch/steps/CheckJava.cpp#L44)

Prism has an explicit Java test in Settings. XMCL resolves the selected instance runtime and reports Java
selection failures with typed causes. Launcher exposes a separate Java check through Settings and the Host.
It uses the exact release requirement and reuses the runtime verification used by Play.
[Prism Settings Java test](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ui/widgets/JavaSettingsWidget.cpp#L373-L390) ·
[XMCL Java launch checks](https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/launch/pluginLaunchPrecheck.ts#L129-L148)

## Current coverage and maturity requirements

| Capability                  | Current source                                                                                                                                                                                                                                                              | Ordinary outcome required for maturity                                                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versions and configurations | Instances pin exact Vanilla, Fabric, Forge or NeoForge selections in the supported lanes, select managed or local Java and set a memory cap. A version or loader change can update the same instance or produce an independent copy with the current worlds.                | Select an exact release and compatible loader version. Pin the choice per instance. Allow renaming, independent duplication and removal with save disposition. Scope each setting to its instance.                                                                                                                                             |
| Installation and repair     | Preparation records its phase, cancellation and result. Upgrades verify the target first and then copy the live worlds or back them up before publishing the new selection. Verified files are reused.                                                                      | A first-time install exposes phase, progress, cancel and retry. A repaired install reuses verified files and identifies the failing step. A failed update keeps the previous runnable selection. A prepared instance remains usable with cached metadata when the metadata service is unreachable and its approved sign-in state permits play. |
| Account                     | Launcher can store multiple protected profiles, migrate the previous encrypted account, select a default or per-instance profile and reconnect the same identity. An unexpired entitlement-verified credential works without network access.                                | Authorize the packaged app with the approved client and a licensed account. Complete sign-in, switch between two genuine profiles, verify account-specific launch identity and recover an expired or denied authorization.                                                                                                                     |
| Process and diagnostics     | Launcher retains a bounded local log, reports exit status and stops only the exact current session. Logs routes recognized failures to the available recovery panels and filters known credentials and paths from clipboard copies. The same session feeds the Overlay.     | Observe startup, running and exit status. Stop the correct process. Inspect bounded local output, crash reason and actionable recovery. A copied log is sanitized before disclosure.                                                                                                                                                           |
| Content                     | Modrinth and local JARs serve Fabric, Forge and NeoForge. The REZICS catalogue serves Fabric. `.mrpack` previews exact versions and file ownership, applies same-version updates, exports pack references and can copy selected worlds into a separately installed release. | Browse and install into the chosen instance, show required or incompatible mods, update under an explicit decision, and keep a previous usable install on failures. Import and export `.mrpack` with concrete game and loader selections, hashed files and controlled client overrides.                                                        |
| Worlds                      | Whole instances and individual worlds can be snapshotted, previewed, restored, retained, deleted or moved between instances. Recovery copies protect live files during restore.                                                                                             | Choose a world in the instance, preview and restore that world without affecting its siblings, and know which Java game version the snapshot came from. Diagnose where the saves and snapshots are stored.                                                                                                                                     |

Current coverage comes from the [Minecraft adapter](../../packages/launcher-core/src/minecraft.ts),
[account owner](../../packages/launcher-core/src/minecraft-auth.ts),
[instance persistence](../../packages/launcher-core/src/instances.ts), [package installer](../../packages/launcher-core/src/packages.ts),
[save owner](../../packages/launcher-core/src/saves.ts) and [desktop renderer](../../apps/launcher/src/renderer/main.tsx).

XMCL resolves assets by content hash and checks the local store before asking for missing or damaged files.
Launcher reports completed asset and library batches so progress covers both cache checks and downloads.
[XMCL asset checks](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/installer/assets.ts#L211)

XMCL separates reading version files from normalizing descriptors and resolving their inheritance.
Launcher uses that resolver on the checked bytes saved by preparation. Independent installs can reuse
the same descriptor, and a later provider revision can have its own cached copy.
[XMCL version resolver](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/core/version.ts#L489)

The Apache-2.0 Fabric Meta source is cloned at `.reference/launcher/fabric-meta`. Its profile handler
combines the loader's dependency metadata with Maven coordinates for the loader and Intermediary.
Launcher puts the published SHA-1 into the artifact record XMCL uses and fetches it from the official Maven
repository when the profile supplies only the coordinates.
[Fabric Meta profile handler](https://github.com/FabricMC/fabric-meta/blob/e4b8a16cb53cf2c82b1cfd82181eca6153c2ef7b/src/main/java/net/fabricmc/meta/web/ProfileHandler.java#L113) · [Fabric Loader metadata generator](https://github.com/FabricMC/fabric-loader/blob/cb9523bc29ef775c50b6aef5e43bc56927cd8e67/gradle/installer-json.gradle#L69)

Prism keeps a default account separately from saved profiles and clears the default when that profile is removed.
XMCL distinguishes transient refresh failure from credentials that need attention. REZICS fixtures exercise both
account choices, encrypted migration, cancellation, online recovery, and plain-language failures for application
approval, Xbox authorization, Minecraft Java ownership, player profile and connectivity. [Prism accounts][prism-accounts] ·
[XMCL account refresh][xmcl-accounts] · [Microsoft device-code responses][device-code]

Prism starts its device flow as a background task and connects completion and cancellation to the dialog.
Launcher keeps the equivalent task in the desktop host so the player can leave the account panel while
approving in the browser. It polls at the provider's interval and resumes the display from host state when
the player returns. [Prism device task][prism-device] · [Microsoft device-code responses][device-code]

PortableMC's terminal sign-in exposes the verification address and user code while the account holder
authorizes in a browser. REZICS exposes those same public challenge fields from the profile's running host
and keeps the existing desktop and terminal preparation and account handling together.
[PortableMC device flow](https://github.com/theorzr/portablemc/blob/e1a5220e34ec82d5efd16a070eee440a85776e60/portablemc-cli/src/cmd/auth.rs#L173-L214)

Prism offers a setting to quit after the game stops and adds a quit step to the launch task. Launcher offers
that choice when the tray receives Quit during a session. Its own exit also waits for the local save backup
and launch report. [Prism quit step](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/launch/steps/QuitAfterGameStop.cpp)

The Modrinth App repairs a managed pack by using the linked project and installed version. Launcher verifies
required files on Play and repairs from the retained manifest and original overrides for the installed release.
It also uses the saved digest or original local file to repair an individually managed JAR.
[Modrinth managed repair][modrinth-managed-repair]

The Modrinth App resolves an instance content plan before its background job installs that plan. Launcher
shows the required changes and checks that the player-confirmed plan still matches the instance before it stages
JARs. [Modrinth content plan](https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/api/instance/projects.rs#L81)

Prism follows requirements when enabling mods and follows enabled dependents when disabling them. Its review
lists the related mods before the player confirms. REZICS applies this to the installed dependencies recorded
in its managed package ledger and commits the reviewed group through its existing package transaction.
[Prism dependency directions](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/mod/ModFolderModel.cpp#L418-L447) ·
[Prism confirmation](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/mod/ModFolderModel.cpp#L500-L536)

Prism scans the instance's disk folders for mod files. Fabric looks for top-level JARs and excludes hidden
files. Fabric and Forge report duplicate IDs during resolution. Launcher reads the instance folder directly,
uses the ledgers for ownership, and shows repeated IDs as diagnosis while the game loader resolves candidates.
[Prism folder scan](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/launch/ScanModFolders.cpp#L43-L68) ·
[Fabric candidate filter](https://github.com/FabricMC/fabric-loader/blob/cb9523bc29ef775c50b6aef5e43bc56927cd8e67/src/main/java/net/fabricmc/loader/impl/discovery/DirectoryModCandidateFinder.java#L45-L95) ·
[Fabric resolution](https://github.com/FabricMC/fabric-loader/blob/cb9523bc29ef775c50b6aef5e43bc56927cd8e67/src/main/java/net/fabricmc/loader/impl/discovery/ModResolver.java#L218-L229) ·
[Forge resolution](https://github.com/MinecraftForge/MinecraftForge/blob/8bdaec882b9bfd76e9dfdf67a22a924f677b1062/fmlloader/src/main/java/net/minecraftforge/fml/loading/UniqueModListBuilder.java#L80-L86)

Prism uses the `.disabled` suffix for local files. Its disable operation chooses a unique name when the
destination already exists. REZICS keeps the exact archive basename, uses the same suffix, and reports an
occupied destination. Launcher and pack ledger names are reserved in both states.
[Prism file state](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/mod/Resource.cpp#L272-L303)

Prism filters loader choices against the selected Minecraft release and resolves the resulting components as a task.
XMCL's update design treats stored pack and mod files as distinct from version metadata. REZICS keeps the previous
installation record until the candidate is verified. In-place changes require a mod-free instance and a backup of
existing worlds. Prism's copy dialog can include the save directory, and XMCL can copy a single world between
instances. REZICS offers all worlds, selected worlds or no worlds when preparing an upgraded copy. The copy keeps
Launcher settings while the source retains its worlds, mods, pack and configuration. Fixtures cover cancellation,
failure, conflicting requests, a replaced source world and restart after atomic publication.
World compatibility depends on what Minecraft and its mods wrote to each world. [Prism version picker][prism-versions] ·
[Prism component resolution][prism-profile] · [XMCL instance update design][xmcl-instance-update] ·
[Prism copy dialog](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ui/dialogs/CopyInstanceDialog.cpp#L231) ·
[XMCL world copy](https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/instance/InstanceSavesService.ts#L276)

Mojang recommends backing up worlds before changing the game version because an older release may permanently
damage a world. The [version-change contract](../launcher.md#minecraft-maturity) applies this risk to the
original instance and the separate copy.
[Mojang game version guidance](https://help.minecraft.net/hc/en-us/articles/360034754852-Changing-game-versions-)

Prism reads a world ZIP's `level.dat` to locate its world folder. XMCL also accepts a save directory containing
`level.dat` and chooses an available destination. Launcher previews either source, stages an independent world,
and leaves existing destination folders in place. [Prism world import][prism-world-import] ·
[XMCL save import](https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/instance/InstanceSavesService.ts#L367) ·
[XMCL world reader tests][xmcl-world-reader]

GNU Coreutils 9.10 calls its pinned gnulib `renameatu` for no-clobber moves. When the filesystem cannot
honour the flag, gnulib can check the destination and then invoke ordinary rename. This leaves a race
between the two operations. REZICS calls the Linux primitive directly to require an atomic claim of
the destination. Both GPL-3.0-or-later references are cloned under `.reference/launcher/`.
[GNU Coreutils move path](https://github.com/coreutils/coreutils/blob/89b2cd58ac895e3fc0d24d8f10e7e4ba132e7fb6/src/copy.c#L1651-L1659) ·
[gnulib fallback](https://github.com/coreutils/gnulib/blob/1c5e0277c2143dd570d8c88f8923eed2afd8e13b/lib/renameatu.c#L96-L154)

XMCL's Java world reader decodes the gzipped NBT `Data` compound. Its sample records `Data.Version.Name`
and the `Snapshot` flag in `level.dat`. Launcher reads the stable release label from those fields with a
bounded reader for both folder and ZIP previews. The comparison uses the destination instance's exact release.
[XMCL level reader](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/game-data/level.ts#L189)

## Build and verification order

1. **Versioned instances and managed Java.** Contract and Minecraft owner add an exact selection of game version,
   loader kind and version, and runtime policy. Read existing 1.21.1 records into the canonical model without changing
   their effective launch target. Read official game and loader metadata with independently cached stable lists.
   Resolve Java from the game manifest plus loader constraints. Probe the chosen executable's major version and
   architecture before use. Verify current and previously stored instance choices, a Java mismatch, and a metadata
   outage with fixtures. Start with Vanilla and Fabric, then qualify Forge and NeoForge independently.
2. **Install, repair and process foundation.** Minecraft owner gives each install attempt an instance-scoped state
   and typed progress, failure or cancellation. Reuse XMCL tasks and checksums. Keep a metadata record of the last
   runnable selection and commit only after verification. Coordinate shared downloads by artifact identity and file
   digest. Bound concurrent transfers, redact secrets before logging, stream process output, and keep log tails,
   sessions and exit codes under the process owner. Use a local fixture executable and checksum-bound served files.
   Interrupt a download and the next launch, corrupt one cached file, and show that repair touches only missing or
   corrupt artifacts. Prove cancellation, log truncation and redaction, exit status, and stale stop rejection.
   Launcher UI exposes those operations through a common progress and failure surface.
3. **Ordinary play and account recovery.** Authorize the installed app with a licensed account on Windows x64.
   Install and start the selected lanes, enter a throwaway world, quit and relaunch, switch accounts and verify a
   denied or expired credential is actionable. Exercise locally cached relaunch within the accepted entitlement
   policy and deliberate sign-out. Keep tokens in the host's protected store. A fake PID or a mocked credential
   test provides development evidence. The release check asks the player to reach the actual game.
4. **Modpacks and worlds.** Use Modrinth as the first pack provider and local `.mrpack` archive import/export.
   Preview declared files, exact versions and overrides before mutation. Reject archive paths outside the instance,
   normalized path collisions and unsupported loader or file sets, and verify published hashes before promoting
   staged resources. Only replace files the previous pack owned. Exercise a real pack and a fixture update with
   changed and removed files, unexpected hashes, denied downloads and interrupted commit. Minecraft contributes
   world selection and summaries, and the shared save service handles a single named world, history and recovery.
   Prove the world's sibling and independent instances remain untouched.

Keep analysis anchored to the actual work in one instance or one archive. Streams bound memory and staging bytes
independently of history size. Key jobs and logs by instance and session. A new job reads its own configuration,
dependency set and previous install record. Bound each version/mod list and log read, use continuation where lists
can grow, and exercise fixtures with unrelated instances and world histories. Publish an exact supported matrix
with results for each row, including install, world entry, launch failure recovery and second launch.

XMCL's native precheck uses the version directory by default. Prism extracts native libraries
during its launch task and removes them during finalization. REZICS gives each Java process its own
extraction directory while retaining the verified library archives in the shared cache.
[XMCL native precheck](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/core/launch.ts#L347-L485) ·
[Prism ExtractNatives](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/launch/ExtractNatives.cpp)

The official manifest returned Java 25 for stable Vanilla 26.3 on 2026-11-21, Java 21 for 1.21.1, Java 17 for
1.20.1 and Java 8 for 1.12.2. The first suggested qualification lanes are current Vanilla, 1.21.1 Fabric,
1.20.1 Forge and 1.21.1 NeoForge. Adopt a JVM 8 lane explicitly before claiming legacy support. Record exact
artefact IDs in fixtures and derive Java requirements from upstream metadata plus loader constraints.
[Mojang release manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) ·
[Minecraft Java Edition 26.3](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)

Forge's repository index groups Maven coordinates by exact game version. NeoForge 21.1 uses its own release
index, where 21.1 is the Minecraft 1.21.1 line and `-beta` is an explicit prerelease. The official
`1.20.1-47.4.10` and `21.1.206` installer archives matched their published SHA-1 checksums and contained
separate client launch profiles and processor lists. Forge declares hashes for some outputs, including its
split client artifacts. NeoForge's profile omits output hashes for these processor steps. The adapter uses
Mojang's hash for client mappings, checks upstream-provided output hashes, and records generated output hashes
for repair where the profile supplies none. It uses XMCL to resolve the processor arguments, install their
dependencies and run their Java entry points. [Forge release catalogue][forge-downloads] ·
[Forge installer processor source][forge-processors] · [NeoForge versioning][neo-versioning] ·
[NeoForge release catalogue][neo-downloads] · [NeoForge sources][neo-source]

The current official catalogue separates legacy NeoForge `21.1.267` for Minecraft 1.21.1 from the
four-component `26.3.0.115` for Minecraft 26.3. The third component of the newer ID identifies the Minecraft
hotfix line. In the older naming scheme, an omitted game patch maps to zero, such as `1.21` and `21.0.x`.
The Forge catalogue already groups by the complete game ID. The checked 1.21.1 Forge installer requests
sanitized mappings, which carry a different checksum from the raw Mojang download. The checked NeoForge
26.3 installer uses `PROCESS_MINECRAFT_JAR`. The official 26.3 client JAR has no bundled server library list.
Launcher sends any extraction to staging and checks that the client step did not emit separate libraries.
[NeoForge current versioning](https://docs.neoforged.net/docs/gettingstarted/versioning/) ·
[Forge InstallerTools mappings processor](https://github.com/MinecraftForge/InstallerTools/blob/4dfe94c6b1ceb083b61efee6032302a6dfce07ee/src/main/java/net/minecraftforge/installertools/DownloadMojmaps.java) ·
[NeoForge InstallerTools client processor](https://github.com/neoforged/InstallerTools/blob/44ddd5a05b9d3186d1b01238bdaa552c1e64bbbb/src/main/java/net/neoforged/installertools/ProcessMinecraftJar.java)

On Node 26, the installed ZIP reader stalled when reading the official multi-megabyte patch entries directly
from a file. The adapter reads the verified installer within a size limit before opening its entries. The
fixture exercises an incompressible patch of the same size class. Pack and mod manifests use the maintained
`yauzl` reader, which successfully streams storage and deflate for multi-megabyte pack files in Node 26.
[Upstream Node 26 report](https://github.com/thejoshwolfe/yauzl/issues/176)

On Fedora, Mojang's managed Java 17.0.15 loaded the system zlib-ng and produced differently compressed Forge
split JARs. Comparing every decompressed entry showed identical data and order. Eclipse Temurin 17.0.15+6 on
the same host reproduced both published SHA-1 values. The Launcher completed installation and repair for
Forge 47.4.10 with that custom Java runtime and the official game, library and loader downloads.
The adapter keeps the published checksum as the acceptance condition and suggests another Java 17
distribution when a Forge processor produces a checksum mismatch. [Forge compressor compatibility][forge-compression]

Forge 52.1.21 on Minecraft 1.21.1 passed its sanitized mappings checksum. On the same Fedora host the managed
Java 21 produced an intermediate client JAR with SHA-1 `e1b074ed106e5540b55853fdd76e6301a3aff942`.
Forge expected `fd32ce6ddf1bc49a9c1a00f273cbcb2aa7ac9d18`. Selecting Eclipse Temurin 21.0.13.1+2 passed
the published processor checks. The managed Java 21 ZIP library links to the system `libz` on this host.
[Eclipse Temurin 21.0.13.1+2](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13.1%2B2)

The Node transport fixture serves small local archives with these profile shapes. It exercises both exact
loader choices, matching custom Java, a Java major mismatch, stale-file repair and cancellation inside a
processor while preserving the previous usable version. Its executable is a local fixture. Windows x64
installation, account sign-in and game entry remain separate qualification results.

Linux qualification prepared NeoForge 21.1.206 for Minecraft 1.21.1 using its official downloads and the
managed Java 21 runtime. Public pack qualification verified apply and export of Mercury Forge Beta 1.0.0
with 24 resources and Fabulously Optimized 6.5.0 with 50 manifest entries. Fabulously Optimized reused the
verified files with networking disabled and produced byte-identical repeat exports.
[Mercury release](https://modrinth.com/modpack/mercury-performance/version/M4Ij32cv) ·
[Fabulously Optimized release](https://modrinth.com/modpack/fabulously-optimized/version/6.5.0)

On Fedora 44, the managed OpenJDK 17.0.15 loaded the host compression library. For Forge 47.4.10 its split
JARs had identical entry order and decompressed contents to the canonical output. The ZIP bytes failed
Forge's published checksums. With Eclipse Temurin 17.0.15+6 selected, Launcher completed preparation and
repair for that exact Forge lane with all published checks enabled. The error gives a compatible Java 17
selection as a recovery action.
[Forge compression issue](https://github.com/MinecraftForge/Installer/issues/80)

## External conditions and scope cuts

Use the REZICS public-client registration accepted by Minecraft Services and a licensed Minecraft Java account.
Keep the official game and runtime downloads with authorized sources and retain the independent Launcher identity.
A successful mocked OAuth response or entitlement fixture cannot establish that the REZICS application is approved.
The first authorized Windows x64 live test can proceed as soon as the approved app configuration and licensed
account are available. [App ID review](https://aka.ms/mce-reviewappid) · [Minecraft EULA](https://www.minecraft.net/en-us/eula)

Modrinth's API requires identifying requests and publishes rate-limit headers. Treat provider downtime and throttling
as distinct from broken local state. CurseForge is a second provider with independent API approval, terms and author
distribution consent. Offer provider support only through an approved credential path with clear states for files
that cannot be installed through it. Store launcher references separately from provider access or redistribution
rights. [Modrinth API](https://docs.modrinth.com/api/) ·
[CurseForge application](https://support.curseforge.com/support/solutions/articles/9000208346) ·
[CurseForge distribution settings](https://support.curseforge.com/en/support/solutions/articles/9000207877)

Later scope includes additional package formats, optional server management, an always-current snapshot lane,
extensive graphics or Java tuning, and other operating systems. The evidenced recommendation is highly feasible
for the stated Windows Java lanes. It would change if the chosen XMCL release cannot support current Mojang or
loader manifests through its ordinary APIs, or if the authorized Windows launch cannot meet the entitlement and
process qualification. In that case isolate the failing adapter and compare alternative implementations against
the same fixtures and live run.

[prism-launch]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/LaunchController.cpp#L82
[prism-accounts]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/auth/AccountList.cpp#L142
[prism-device]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ui/dialogs/MSALoginDialog.cpp#L108
[prism-world-import]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/WorldTasks.cpp#L31
[xmcl-world-reader]: https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/game-data/level.test.ts#L12
[prism-versions]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ui/pages/instance/VersionPage.cpp#L347
[prism-profile]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/PackProfile.cpp#L329
[xmcl-instance-update]: https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/instanceIO/InstanceUpdateDesign.md
[xmcl-accounts]: https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/user/accountSystems/MicrosoftAccountSystem.ts#L55
[device-code]: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
[prism-components]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/ComponentUpdateTask.cpp#L24
[prism-java]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/java/JavaChecker.cpp#L125
[prism-pack]: https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/modplatform/modrinth/ModrinthInstanceCreationTask.cpp#L93
[xmcl-install]: https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/install/InstallCoordinator.ts#L142
[xmcl-launch]: https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/launch/LaunchService.ts#L478
[core-install]: https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/installer/installer.ts#L59
[core-java]: https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/installer/java-runtime.ts#L110
[forge-downloads]: https://files.minecraftforge.net/net/minecraftforge/forge/index_1.20.1.html
[forge-processors]: https://github.com/MinecraftForge/Installer/blob/87803a77943a1b2d02d69e7c3108042b21f5382d/src/main/java/net/minecraftforge/installer/actions/PostProcessors.java
[forge-compression]: https://github.com/MinecraftForge/Installer/issues/80
[neo-versioning]: https://docs.neoforged.net/docs/1.21.11/gettingstarted/versioning/
[neo-downloads]: https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge
[neo-source]: https://github.com/neoforged/NeoForge/tree/0da72d30889eb4d37eebbb70c84b83701829a6b5
[modrinth-pack]: https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/api/pack/install_mrpack.rs#L146
[modrinth-managed-repair]: https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/api/instance/projects.rs#L424
[modrinth-process]: https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/state/process.rs#L266
[modrinth-logs]: https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/api/logs.rs#L19
[packwiz-export]: https://github.com/packwiz/packwiz/blob/170b22d785959dda5876b54b7f16e1b807a57fb6/modrinth/export.go#L189
[pcl-java]: https://github.com/PCL-Community/PCL2-CE/blob/5a99917e06c6e25b8d910dd52887634e31696787/PCL.Core/Minecraft/Java/JavaService.cs#L25
[pcl-download]: https://github.com/PCL-Community/PCL2-CE/blob/5a99917e06c6e25b8d910dd52887634e31696787/PCL.Launcher.Core/Download/Core.cs#L78
[pcl-pack]: https://github.com/PCL-Community/PCL2-CE/blob/5a99917e06c6e25b8d910dd52887634e31696787/PCL.Launcher.Core/Modpack/Modrinth.cs#L13
