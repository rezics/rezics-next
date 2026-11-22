# Launcher and Overlay MVP proposal

## Product scope

Build Launcher and Overlay in the REZICS monorepo. A player imports or creates a game instance, launches it, opens
REZICS information and guides from an in-game overlay, and can recover a previous local save. The two acceptance
targets are Minecraft Java Edition and a Visual Novel. The online distribution increment gives Launcher an
Extensions-style catalog with a usable install and update flow.

Start with Windows x64, one supported Minecraft Java version with Vanilla and Fabric, and one Ren'Py VN. Include a VN
with a manually selected save location as a second fixture for the path fallback. Windowed and borderless game modes
are the first Overlay targets. Keep the downloaded game and Java runtime on their authorized upstream paths. Offer
an import and handoff to an existing launcher for early integration while the REZICS Microsoft application and a
licensed account are being verified. Independent Minecraft sign-in and a clean install remain release acceptance.
[Minecraft AppID review form](https://aka.ms/mce-reviewappid) · [Minecraft EULA](https://www.minecraft.net/en-us/eula)

Community publication, arbitrary executable Launcher extensions, general dependency solving, binary hosting, save
cloud sync, exclusive fullscreen and additional operating systems are later increments.

## Ownership in the monorepo

| Proposed location                | Owns                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/launcher`                  | Electron Main in TypeScript owns the local library, instances, launch, session, installs and save jobs. React renderer owns Library, game details, Mods, Saves and Extensions. Use the existing Bun workspace and Electron's Node.js at runtime. |
| `apps/overlay`                   | One independently startable Rust process owns window placement, DPI, hotkey, foreground tracking, focus and input. Start with Wry/WebView2 and a bundled React UI. Build the web assets through the workspace and the native host through Cargo. |
| `packages/launcher-contract`     | A small shared wire contract with fixtures read by TypeScript and Rust. Start with session snapshot/change and REZICS destinations.                                                                                                              |
| `packages/ui`, `packages/client` | Reuse suitable React components, tokens and the existing platform client. Use external-browser links for Subject, Guide and Community.                                                                                                           |
| `services/kernel`                | Owns published package and release facts needed for distribution. Use the existing product API, authorization and release lifecycle. Link game identities to existing Subjects when present. The desktop apps own user-local state.              |

Keep Launcher services organized as ordinary TypeScript modules. Wire Minecraft, VN, save discovery, backup and
download adapters at startup with a small set of typed interfaces. An adapter is scoped to the app, an instance or
a live session according to what it owns. Use cancellation and explicit disposal for background work and listeners.
Add a capability lookup when a second consumer needs it. A running session should have an immutable instance ID
and a new session ID, so a process or window reused by the OS cannot accidentally inherit the previous session.

## Launcher and Overlay integration

Develop the two together through a fixture for a startable game window and a feed of session snapshots. The Launcher
owns game identity, launch and process lifetime. The Overlay verifies that its target is the active window for the
reported session and owns the UI's visibility and focus. A first IPC can use a Launcher-spawned child's standard
streams with versioned, size-bounded JSON messages. The independent Overlay executable can also run against the
fixture. The normal flow needs the current session, session changes, and an action such as opening an approved REZICS
destination. Electron's isolated preload exposes typed actions. The overlay bridge accepts the same small action set.
Keep tokens, filesystem paths and commands in their owner process. Closing the Launcher window leaves Main and the
active session available from the tray.

Use `hidden`, `HUD` and `interactive` as visible modes. HUD lets clicks pass to the game. Interactive mode takes
focus and accepts keyboard, mouse and IME. Closing it returns focus to the game when the game still exists.
Re-evaluate window bounds, DPI and foreground state on change. Hide on Alt+Tab away or game exit. Recover from a
lost host connection and make Overlay failure independent of the game process.

Tao combines non-client activation and keyboard focus when reporting focus events. Overlay listens for `WM_ACTIVATE`
on its own top-level window so that a WebView child can hold keyboard focus while deactivation still closes the panel.
[Tao Windows events](https://github.com/tauri-apps/tao/blob/cc987583ab3adec3e0691ea4c06bc13d908d78cf/src/platform_impl/windows/event_loop.rs#L1729) ·
[Win32 activation](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-activate)

The per-monitor-aware Overlay thread reads the full client rectangle from `GetWindowInfo`. A mirrored game can
have its client origin at the right edge. Windows can also scale a DPI-unaware game's client area on behalf of
the process. Reading all four screen edges together keeps placement tied to the visible game.
[Win32 window information](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-windowinfo) ·
[Win32 window mirroring](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#window-layout-and-mirroring) ·
[Mixed-mode DPI scaling](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-improvements-for-desktop-applications)

Win32 orders topmost windows within their own group. ShaderGlass uses `SetWindowPos` for topmost placement.
REZICS reads the window immediately above the active topmost game and puts Overlay into that position when
the game raises itself. An order-only update leaves the client rectangle and foreground input in place.
[Win32 Z-order](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#z-order) ·
[Win32 positioning](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) ·
[ShaderGlass topmost placement](https://github.com/mausimus/ShaderGlass/blob/12599475101dc4e64eef11469f33efd653586ba2/ShaderGlass/ShaderWindow.cpp#L1307)

Win32 disables a modal dialog's owner while the dialog is open. Tao documents the same ownership arrangement
for application-created modal windows. Overlay checks both the window's enabled state and its direct owner's
state before selecting a client area or accepting input for it.
[Win32 dialogs](https://learn.microsoft.com/windows/win32/dlgbox/about-dialog-boxes) ·
[Tao window ownership](https://github.com/tauri-apps/tao/blob/cc987583ab3adec3e0691ea4c06bc13d908d78cf/src/platform/windows.rs#L266)

PowerToys handles failure from `RegisterHotKey` as a distinct result. Launcher uses the same Win32 result to
explain unavailable registration and offer a retry while the game continues. [PowerToys hotkey registration](https://github.com/microsoft/PowerToys/blob/b1bb9bb89bff94a24e93bc0b8b59901e9879830d/src/runner/centralized_hotkeys.cpp#L61) ·
[RegisterHotKey return value](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey#return-value)

Wry's transparent example and Windows backend support the first prototype. Read the CEF and Electron offscreen
implementations for a separate experiment in a REZICS-owned test game. Compare hotkey-to-visible time, idle CPU and
memory, game frame times, input/IME, recovery after a render restart, and behavior on two monitors at different DPI.
Adopt a second compositor only after a named supported game requires it and the experiment shows a workable
render/input lifecycle. Steamworks describes CEF offscreen as an embedding workaround for browser-based games.
[Steamworks Overlay](https://partner.steamgames.com/doc/features/overlay) ·
[Electron offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/) ·
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security)

PowerToys exposes its Shortcut Guide enablement and invocation shortcut in normal Settings. Launcher
likewise lets players set both before starting a game and applies them through the session owner.
[PowerToys Shortcut Guide settings](https://github.com/microsoft/PowerToys/blob/b1bb9bb89bff94a24e93bc0b8b59901e9879830d/src/settings-ui/Settings.UI/ViewModels/ShortcutGuideViewModel.cs#L121-L169)

## Local game and save lifecycle

- **Minecraft.** Evaluate XMCL Core first for version resolution, assets, libraries, launching and the authentication
  integration. Validate Java runtime acquisition, the REZICS application identity and entitlement on Windows. Pin one
  supported release and Fabric loader combination for the first walk. Isolate each instance's mods and worlds.
  Share reusable downloads where their identity and digest agree. Query Modrinth for compatible releases, install a
  selected version with its resolved required files, and support local JAR import. Surface missing or conflicting
  requirements before changing the instance. Fabric retains responsibility for validating the actual load.
- **Visual Novel.** Import an installed executable and choose its working directory. Link a REZICS work when known.
  Resolve Ren'Py's game-specific save folder, including persistent progress, and support a user-selected path for
  unfamiliar engines. Keep personal files separate from the installed game and from REZICS catalog facts.
  Playnite edits the existing game record by ID. The visual novel settings preserve the same entry and backup
  history while replacing its installation or association. [Playnite game editor](https://github.com/JosefNemec/Playnite/blob/8c08a305d68e287e71984ea691239212a6046cf7/source/Playnite.DesktopApp/ViewModels/GameEditViewModel.cs#L936)
  Playnite presents recursive folder scan results before importing selected executable records. REZICS gives
  that review to the host caller and groups potential visual novel launchers by installation directory.
  [Playnite folder scan and import](https://github.com/JosefNemec/Playnite/blob/8c08a305d68e287e71984ea691239212a6046cf7/source/Playnite.DesktopApp/ViewModels/InstalledGamesViewModel.cs#L451-L495)
  Playnite removes game records through a separate action from uninstalling game files. REZICS archives an
  imported record and its backup history together so the player can restore its existing identity.
  [Playnite game removal](https://github.com/JosefNemec/Playnite/blob/8c08a305d68e287e71984ea691239212a6046cf7/source/Playnite/GamesEditor.cs#L919-L954) ·
  [Playnite uninstall](https://github.com/JosefNemec/Playnite/blob/8c08a305d68e287e71984ea691239212a6046cf7/source/Playnite/GamesEditor.cs#L1157-L1190)
  The cloned Ren'Py 8.5.3 builder records `config.name` and `config.version` in its build information and
  distributes it as `game/cache/build_info.json`. Launcher uses those display fields when script metadata
  is unavailable, including compiled-only installs.
  [Build information](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/common/00build.rpy#L631) ·
  [Distribution file](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/launcher/game/distribute.rpy#L1042)
  The same SDK gives `RENPY_PATH_TO_SAVES` priority over ancestor folders named `Ren'Py Data` and platform
  defaults. Desktop Ren'Py can write to that per-game profile and the installation's save folder in the same
  session. The Launcher resolves the named profile in that order and keeps both backup scopes available.
  [Save path resolution](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy.py#L169) ·
  [Save locations](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/savelocation.py#L683)
  Ren'Py also chooses its first existing content directory by the executable's name, then its name suffixes,
  then the standard directories and package root. The desktop package establishes its base before the engine
  checks those candidates. Launcher reads metadata and game-local saves from that same selected directory.
  [Content directory order](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy.py#L35) ·
  [Runtime base and executable name](https://github.com/renpy/renpy/blob/39895c1e017f0b36ffea2447d97eccd69d76ee1c/renpy/bootstrap.py#L269)
- **Saves.** Give each instance a stable backup identity and each snapshot a stable ID, creation time, optional label
  and game/loader/mod version context where available. Use a TypeScript service and evaluate Ludusavi CLI with
  isolated configuration and a per-instance backup target. Verify preview, backup history, redirects and restore
  in fixtures before committing to it as the engine. Back up on demand and after a known game exit. Preview restore
  destinations, require the game to be closed, take a recovery snapshot and preserve recoverability after an
  interrupted restore. Keep snapshot metadata and payloads addressable separately so future authenticated
  REZICS storage can receive a snapshot without binding it to a machine path.

Test two instances of the same game, interrupted install or restore, failed backup, and a saves directory outside
the game folder. Apply local work only to the selected instance, serialize writes per instance and stream large
files through staging without loading a whole world or archive into memory. Show a failed automatic backup in
Saves and keep the last good snapshot available. Reuse the engine's retention policy when it preserves snapshots
the user wants to keep.

Ludusavi applies user-configured redirects during restore. Launcher lets the player choose a destination per
visual novel save folder within the receiving instance's configured locations. A restore checks the reviewed
paths and folder identities before replacing files.
[Ludusavi restore redirect handling](https://github.com/mtkennerly/ludusavi/blob/c4c2ca9943e841a7c052a59e9757535e77e80e0a/src/scan.rs#L64-L118)

Ludusavi's CLI offers a separate restore preview and JSON output for scripts. Launcher uses the same
reviewed restore plan as its desktop UI, so a headless caller can inspect the exact destinations and then
apply that review through the profile's running host.
[Ludusavi restore arguments](https://github.com/mtkennerly/ludusavi/blob/c4c2ca9943e841a7c052a59e9757535e77e80e0a/src/cli/parse.rs#L244-L280)

Ludusavi evaluates and reports backup work per game. Launcher likewise reports automatic backup readiness
per instance so one invalid selection leaves the other results usable.
[Ludusavi backup loop](https://github.com/mtkennerly/ludusavi/blob/c4c2ca9943e841a7c052a59e9757535e77e80e0a/src/cli.rs#L292-L365)

## Online distribution for Launcher

Follow the VS Code interaction: find a package, inspect publisher and compatibility, install an exact version,
see what is installed, update, and remove or disable it as appropriate. REZICS publishes the version metadata.
GitHub Releases or another authorized upstream delivers the artifact. Begin with curated entries published through
the existing authorization and API path. Prove the full loop with a declarative Overlay guide panel or preset, and
one curated Fabric release. Modrinth can also be queried directly as a separate source inside Minecraft instances.
[VS Code Extension Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace) ·
[VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest) ·
[GitHub release assets](https://docs.github.com/en/rest/releases/assets)

VS Code registers named contribution points and can derive activation events from their declarations. The
bundled Launcher registry uses declared Library and game panels and an explicit completed-session hook.
[VS Code contribution registry](https://github.com/microsoft/vscode/blob/60385084191c4017b47890036eabef4a92e1b570/src/vs/workbench/services/extensions/common/extensionsRegistry.ts#L680)

VS Code registers its main-thread customers by protocol identifier. Launcher associates each desktop command
with its bundled plugin and uses that declaration to register its main handler and preload function. The renderer
calls the resulting named functions over Electron's isolated bridge.
[VS Code main-thread customer registry](https://github.com/microsoft/vscode/blob/60385084191c4017b47890036eabef4a92e1b570/src/vs/workbench/services/extensions/common/extHostCustomers.ts#L30-L71) ·
[Electron context bridge](https://www.electronjs.org/docs/latest/api/context-bridge)

Electron distinguishes packaged executions from development and exposes the installed resources directory.
Launcher uses those APIs to load the public Minecraft client ID shipped with the package.
[Electron packaged detection](https://github.com/electron/electron/blob/c7ba9db453f3ed92b36c8e5b8dd6da2342bef1b3/shell/browser/api/electron_api_app.cc#L973) ·
[Electron resources path](https://www.electronjs.org/docs/latest/api/process#processresourcespath-readonly)

Bun reads the standalone module graph from the Windows executable's own PE data. This source was reviewed in
the `.reference/launcher/bun` checkout at the revision reported by the test executable. Launcher compiles the
same host entry used in development into a console executable so agent callers can use normal pipes.
[Bun Windows standalone module graph](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/standalone_graph/StandaloneModuleGraph.rs#L581-L604) ·
[Bun compiler compatibility](https://bun.com/docs/compiler/compatibility) ·
[Bun license and relinking instructions](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md)

The local automation transport binds an ephemeral port to IPv4 loopback and authenticates it with the
profile's per-run capability. The cloned libuv shipped with Electron binds the supplied TCP address on both
platforms. Its Windows named-pipe implementation uses the default security descriptor and pipe mode.
[Node networking](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback) ·
[libuv 1.52.1 Windows TCP](https://github.com/libuv/libuv/blob/1cfa32ff59c076ffb6ed735bbc8c18361558661f/src/win/tcp.c#L1599) ·
[libuv Unix TCP](https://github.com/libuv/libuv/blob/1cfa32ff59c076ffb6ed735bbc8c18361558661f/src/unix/tcp.c#L151) ·
[libuv Windows pipes](https://github.com/libuv/libuv/blob/1cfa32ff59c076ffb6ed735bbc8c18361558661f/src/win/pipe.c#L546)

- **Package.** Stable namespaced ID, kind, publisher, summary and optional related Subject. A package can be found
  using a bounded catalog query and an exact ID lookup. Reuse a catalog projection if it supports these fields.
- **Release.** Immutable version ID, display version, kind-specific compatibility, artifact URL, digest and size.
  Compatibility is Launcher version range for a Launcher add-on and the stated game version and loader for a
  Minecraft mod. The first curated release can include an explicit list of required release IDs if it needs more
  than one artifact. Withdrawal suppresses installs without silently deleting existing local files. Generic search
  projections help discovery. Exact published release reads authorize downloads and supply the version metadata.
- **Install.** Download the exact artifact to a staging location, verify its size and digest, validate its supported
  format, then commit the instance files and installed version with recovery on process restart. A bad digest,
  broken link or interrupted update leaves the previous usable version available. Declarative Launcher content
  uses a fixed schema and built-in UI components. Fabric JARs run in the game profile using its normal loader.

Key exact reads by `(packageId, releaseId)`. For the first version list, seek by `(packageId, publishedAt, releaseId)`
in the published set and return up to 25 entries. Page catalog results through the existing search owner or a small
indexed catalog projection. Resolve dependencies of the selected Minecraft install with a finite per-step bound
and explicit failure for unresolved requirements. Verify that unrelated packages, releases, instances and old
snapshots do not slow exact reads or local changes. A global provider pass, recursive server-side dependency
analysis and a full local package manager can wait.

VS Code opens its exact version picker from an installed extension, and Prism exposes a version-change
action from its instance's mod list. Launcher opens the provider versions from Installed and applies reviewed
releases through the same transaction as the Host CLI.
[VS Code version action](https://github.com/microsoft/vscode/blob/60385084191c4017b47890036eabef4a92e1b570/src/vs/workbench/contrib/extensions/browser/extensionsActions.ts#L1662-L1707) ·
[Prism mod version action](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ui/pages/instance/ModFolderPage.cpp#L115-L119)

Modrinth's managed pack repair uses the project and version IDs already linked to the instance. Launcher
uses the same approach for recovering an installed Overlay panel and retains the original artifact fingerprint.
[Modrinth managed repair](https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/api/instance/projects.rs#L424-L466)

## Delivery sequence and acceptance

| Increment                        | User-visible completion                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Two independent starts        | Launcher imports and launches a fixture game and links to its REZICS page. Overlay opens a React panel over a fixture window with the hotkey, accepts input and restores focus. Close the Launcher window while the game continues. Start Minecraft sign-in verification here.                                            |
| 2. Local game journeys           | On Windows a player installs and launches the selected Vanilla and Fabric releases with a licensed account, installs a compatible Modrinth mod, and restores an earlier world. A player imports and starts a VN then backs up and restores a save and persistent progress. Overlay reads the right session in both games. |
| 3. Distribution through Launcher | Publish a curated add-on and Fabric release, read both back through the ordinary API, install without manual file copying, and update one version. Simulate an unavailable artifact, a digest mismatch and an interrupted update, then open the existing installed version.                                               |

The launcher, overlay and saves can proceed with fixtures while the thin catalog and Minecraft authentication are
verified. The following statuses concern the proposed Launcher flows on the current checkout.

| Capability                                  | Specified                 | Backend implemented          | Interface exposed     | Tested                                         |
| ------------------------------------------- | ------------------------- | ---------------------------- | --------------------- | ---------------------------------------------- |
| Local library, launch and save jobs         | Proposed here             | Desktop work pending         | Pending               | Pending                                        |
| Overlay and session integration             | Proposed here             | Desktop work pending         | Pending               | Pending                                        |
| Minecraft and VN acceptance                 | Proposed here             | Adapters pending             | Pending               | Pending                                        |
| Exact release distribution and local update | Proposed here             | Release distribution pending | Pending               | Pending                                        |
| Game and VN catalog identity                | Existing Subject contract | Existing catalog             | Existing Web overview | Existing coverage, desktop integration pending |

The current checkout already distinguishes a game work, software release and independently referable add-on in
the [Subject page contract](../subject-pages.md). The old registry also distinguished package, release and file.
Its historical schema supplies a comparison for naming. The proposed catalog adds only the release data the
desktop journey needs. Scope adoption belongs in the owning product document before implementation is briefed.

## Reference source

Windows packaging also uses the linkage decision in the MIT-licensed `webview2-rs` clone at
`.reference/launcher/webview2-rs`. The pinned bindings link the loader statically on MSVC and import
`WebView2Loader.dll` on GNU targets. [WebView2 bindings source](https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/crates/bindings/src/lib.rs#L12-L23)

The following 43 read-only shallow clones are in `.reference/launcher/`. The table pins the revision, upstream
licence and source file examined for each. This was a source review. Native runtime behavior and integrations are
acceptance work. Steam Overlay, Visual Studio Marketplace, GitHub Releases, the Factorio Mod Portal and the
CurseForge platform are product or API references whose service implementations are not in the clone set.
[Factorio Mod Portal API](https://wiki.factorio.com/Mod_portal_API) ·
[CurseForge developer console](https://console.curseforge.com/)

Revisit the proposed Wry route if it cannot reliably restore input on both acceptance games. Revisit XMCL if it
cannot satisfy Windows runtime installation and authorized sign-in through its normal library interfaces.
CrustCore declares MIT and describes a port of parts of minecraft-java-core, whose source carries separate
commercial-use restrictions. Check the actual reused code and licence before adopting either implementation.

| Clone                 | Upstream licence                                            | Pinned source                                                                                                                                                                 | Observation                                                                                      |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `vscode`              | MIT                                                         | [`60385084191c`](https://github.com/microsoft/vscode/blob/60385084191c4017b47890036eabef4a92e1b570/src/vs/platform/extensionManagement/node/extensionManagementService.ts)    | Checks compatibility and verifies downloaded extensions before extraction.                       |
| `vsce`                | MIT                                                         | [`50a48d8a2250`](https://github.com/microsoft/vscode-vsce/blob/50a48d8a2250614e943a4c738bce6705976ce9ae/src/validation.ts)                                                    | Validates the host version range when packaging.                                                 |
| `openvsx`             | EPL-2.0                                                     | [`3025cb930b27`](https://github.com/eclipse-openvsx/openvsx/blob/3025cb930b2767229444e6890c965275e6c50349/server/src/main/java/org/eclipse/openvsx/LocalRegistryService.java) | Retrieves published versions and resolves download URLs through storage.                         |
| `electron`            | MIT                                                         | [`c7ba9db453f3`](https://github.com/electron/electron/blob/c7ba9db453f3ed92b36c8e5b8dd6da2342bef1b3/docs/tutorial/offscreen-rendering.md)                                     | Describes bitmap and GPU shared texture output and the native bridge requirement.                |
| `cef`                 | BSD-3-Clause                                                | [`e6035cfb3523`](https://github.com/chromiumembedded/cef/blob/e6035cfb35235e19ea5d5eae62c989b9ef0818dc/include/cef_render_handler.h)                                          | Declares distinct software and accelerated paint callbacks.                                      |
| `wry`                 | MIT OR Apache-2.0                                           | [`259b0969f367`](https://github.com/tauri-apps/wry/blob/259b0969f367b69ee2a54dbdaef033e24719afdd/examples/transparent.rs)                                                     | Creates a transparent native window and transparent WebView.                                     |
| `tao`                 | Apache-2.0                                                  | [`cc987583ab3a`](https://github.com/tauri-apps/tao/blob/cc987583ab3adec3e0691ea4c06bc13d908d78cf/src/platform_impl/windows/window_state.rs#L188)                              | Combined activation and focus state in the locked Windows event loop.                            |
| `egui`                | MIT OR Apache-2.0                                           | [`d33dec58efd1`](https://github.com/emilk/egui/blob/d33dec58efd165add27acb9cddaf7e457eb5e64f/crates/egui/src/viewport.rs)                                                     | Provides a native immediate-mode viewport and window commands.                                   |
| `wgpu`                | MIT OR Apache-2.0                                           | [`0432ab7fb70b`](https://github.com/gfx-rs/wgpu/blob/0432ab7fb70b28cfbfbd77e0d4b2b0c43bc49f70/wgpu/src/api/surface.rs)                                                        | Provides surface configuration and frame presentation primitives.                                |
| `hudhook`             | MIT                                                         | [`a08814e4957f`](https://github.com/veeenu/hudhook/blob/a08814e4957f7c9c9aa909c0f88c9a300ff5f2b4/src/hooks/mod.rs)                                                            | Separates graphics API backends for a native HUD.                                                |
| `gamescope`           | BSD-2-Clause                                                | [`3738994fd253`](https://github.com/ValveSoftware/gamescope/blob/3738994fd253a1c775821625a2c20beb4f879f16/README.md)                                                          | Provides a Linux compositor deployment model.                                                    |
| `gameoverlay`         | GPL-2.0                                                     | [`9e90c45fa280`](https://github.com/momo5502/gameoverlay/blob/9e90c45fa280f2fb51a136df4ba94db3beffa6fe/src/backends/dxgi/dxgi_renderer.cpp)                                   | Shows per-backend DXGI rendering work required for in-game composition.                          |
| `goverlay`            | GPL-3.0 with additional terms                               | [`3ca1f040b180`](https://github.com/hiitiger/goverlay/blob/3ca1f040b180dc6ce84baca093c6f726748461ad/electron-overlay/index.d.ts)                                              | Defines Electron window lifecycle and input integration types.                                   |
| `glint`               | MIT                                                         | [`6e990e89836e`](https://github.com/kewuamigo/glint-overlay/blob/6e990e89836e82d3badf69cacccf39cea3e8c9d7/docs/ARCHITECTURE.md)                                               | Splits the launcher, game-side transport and browser host.                                       |
| `wgpu-weld`           | MPL-2.0 and component terms                                 | [`9edccc08c4bf`](https://github.com/merely-made/wgpu-weld/blob/9edccc08c4bf75b4365fd61cd2f2d9ee96002fb0/welding/src/lib.rs)                                                   | Defines a Web-to-renderer library boundary for an offscreen experiment.                          |
| `dioxus`              | MIT OR Apache-2.0                                           | [`97adf7915e1a`](https://github.com/DioxusLabs/dioxus/blob/97adf7915e1adfef4e2da436c9bd0b6add0dfa39/packages/desktop/src/webview.rs)                                          | Hosts a Rust UI through a native WebView.                                                        |
| `slint`               | Multiple licences in LICENSE.md                             | [`2dbdba11c33b`](https://github.com/slint-ui/slint/blob/2dbdba11c33b4334e0e4c3494a0bdb2707ef14a9/internal/backends/winit/lib.rs)                                              | Uses a native window backend for Slint-rendered UI.                                              |
| `shaderglass`         | GPL-3.0                                                     | [`12599475101d`](https://github.com/mausimus/ShaderGlass/blob/12599475101dc4e64eef11469f33efd653586ba2/ShaderGlass/ShaderWindow.cpp)                                          | Changes hit testing and topmost placement of an external window.                                 |
| `powertoys`           | MIT                                                         | [`b1bb9bb89bff`](https://github.com/microsoft/PowerToys/blob/b1bb9bb89bff94a24e93bc0b8b59901e9879830d/src/modules/alwaysontop/AlwaysOnTop/AlwaysOnTop.cpp)                    | Registers a Windows hotkey and changes the target's topmost state.                               |
| `ludusavi`            | MIT                                                         | [`c4c2ca9943e8`](https://github.com/mtkennerly/ludusavi/blob/c4c2ca9943e841a7c052a59e9757535e77e80e0a/src/scan/layout.rs#L1040)                                                 | Compares the current scan with its previous backup, skips unchanged data in ordinary backup planning, and records file hashes. |
| `ludusavi-manifest`   | MIT                                                         | [`2b0e10c618ff`](https://github.com/mtkennerly/ludusavi-manifest/blob/2b0e10c618ff6b966ec8f129ebc9724b902410dd/src/manifest.rs)                                               | Declares save data, platform and root distinctions.                                              |
| `renpy`               | MIT engine and bundled notices in sphinx/source/license.rst | [`5444c2dfed10`](https://github.com/renpy/renpy/blob/5444c2dfed103a6300d1cb9f299900a5c6d1adb3/sphinx/source/config.rst)                                                       | Documents configurable platform paths for save files.                                            |
| `kirikiri`            | BSD-style and third-party terms in LICENSE                  | [`fd5c4baa6a2e`](https://github.com/krkrz/krkrz/blob/fd5c4baa6a2ef5978db1bd043634351f48667daf/base/StorageIntf.cpp)                                                           | Provides a distinct storage abstraction and a useful test of user-selected paths.                |
| `kirikiri2`           | GPL and original terms in LICENSE and LICENSE.org.txt       | [`dec49af97e17`](https://github.com/krkrz/krkr2/blob/dec49af97e174d31059c3ccd7efc700ba3c6b788/kirikiri2/trunk/kag3/template/system/Config.~new) | The legacy KAG3 template uses CP932 for the display title. |
| `kag3`               | KAG3 terms in README.md                                     | [`1f3ab309106d`](https://github.com/krkrz/kag3/blob/1f3ab309106d210e3169bbbe0fb4e066ae463b42/data/system/MainWindow.tjs#L283-L295) | The modern UTF-8 project resolves a relative KAG save path against the executable. |
| `xmcl`                | MIT                                                         | [`14b1ac11e523`](https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/instanceIO/InstanceInstallService.ts)             | Coordinates instance installation above reusable Minecraft libraries.                            |
| `xmcl-core`           | MIT                                                         | [`154e2719b1ac`](https://github.com/Voxelum/minecraft-launcher-core-node/blob/154e2719b1ac962631d80ae4a280382f4f1ac09d/packages/core/launch.ts)                               | Builds arguments and starts Java with the instance working directory.                            |
| `portablemc`          | Apache-2.0                                                  | [`e1a5220e34ec`](https://github.com/theorzr/portablemc/blob/e1a5220e34ec82d5efd16a070eee440a85776e60/portablemc-cli/src/cmd/auth.rs)                                          | Provides a CLI alternative to a Node library integration.                                        |
| `mc-launcher-core`    | MIT                                                         | [`838daff3e04c`](https://github.com/Star-tears/mc-launcher-core/blob/838daff3e04cfd04b77796f61a6d7d68a36b8aa6/src/launcher.rs)                                                | Offers a Rust launcher facade and a second fallback candidate.                                   |
| `crustcore`           | MIT as declared by upstream                                 | [`769a56a30e81`](https://github.com/Luuxis/CrustCore/blob/769a56a30e812c2a18d9243e821f8a985227dcf3/src/launcher/java.rs)                                                      | Implements platform-specific Java runtime selection.                                             |
| `minecraft-java-core` | Custom Luuxis licence with commercial-use restrictions      | [`fe8573f51689`](https://github.com/Luuxis/minecraft-java-core/blob/fe8573f516892f006423690b264d0dd2ae87b7c4/src/Launch.ts)                                                   | Shows the launch model referenced by CrustCore. Review each upstream separately for reuse.       |
| `prism`               | GPL-3.0-only and bundled notices in COPYING.md              | [`5a52fca7e8e2`](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/LaunchController.cpp)                                  | Coordinates launch steps at the instance level.                                                  |
| `modrinth`            | AGPL-3.0-only server and GPL-3.0-only app                   | [`0444aa6d1f98`](https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/apps/labrinth/src/routes/v2/versions.rs)                                      | Filters project versions by game version and loader.                                             |
| `packwiz`             | MIT                                                         | [`170b22d78595`](https://github.com/packwiz/packwiz/blob/170b22d785959dda5876b54b7f16e1b807a57fb6/core/index.go)                                                              | Maintains a pack file index with per-file hashes.                                                |
| `fabric-loader`       | Apache-2.0                                                  | [`cb9523bc29ef`](https://github.com/FabricMC/fabric-loader/blob/cb9523bc29ef775c50b6aef5e43bc56927cd8e67/src/main/java/net/fabricmc/loader/impl/discovery/ModResolver.java)   | Resolves actual loader candidates at game startup.                                               |
| `neoforge`            | LGPL-2.1-only                                               | [`0da72d30889e`](https://github.com/neoforged/NeoForge/blob/0da72d30889eb4d37eebbb70c84b83701829a6b5/tests/src/main/resources/META-INF/neoforge.mods.toml)                    | Declares loader-specific mod and dependency metadata.                                            |
| `thunderstore`        | AGPL-3.0                                                    | [`fc20b8d2eacc`](https://github.com/thunderstore-io/Thunderstore/blob/fc20b8d2eacc83bc5dbe0784402423fb06e81980/django/thunderstore/repository/models/package_version.py)      | Stores release-specific package files and version facts.                                         |
| `resolvo`             | BSD-3-Clause                                                | [`f8a5147b1d25`](https://github.com/prefix-dev/resolvo/blob/f8a5147b1d25399bda9a5b15efd8aa9c48d512b9/src/lib.rs)                                                              | Provides a separate solver boundary for later package ecosystems.                                |
| `cordis`              | MIT                                                         | [`5e2e6c172335`](https://github.com/cordiverse/cordis/blob/5e2e6c172335d207d11289959322edaaba4447f0/packages/core/src/service.ts)                                             | Provides runtime service context as a comparison for explicit capability wiring.                 |
| `extism`              | BSD-3-Clause                                                | [`051b765bb6ab`](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/plugin.rs)                                                        | Provides a WASM plugin runtime as a separate future decision.                                    |
| `tokio`               | MIT                                                         | [`717c508f9e9a`](https://github.com/tokio-rs/tokio/blob/717c508f9e9ac4317665ff1eb30f29c139ea6363/tokio-util/src/sync/cancellation_token.rs)                                   | Shows cancellation as a lifecycle primitive.                                                     |
| `playnite`            | MIT                                                         | [`8c08a305d68e`](https://github.com/JosefNemec/Playnite/blob/8c08a305d68e287e71984ea691239212a6046cf7/source/Playnite/Controllers/GameControllerFactory.cs)                   | Separates play, install and uninstall controller lifecycles.                                     |
| `rezics-legacy`       | AGPL-3.0                                                    | [`9cbf38587c63`](https://github.com/rezics/rezics/blob/9cbf38587c6396b9d208d5738a08af0a1a1f09d9/libraries/schema/src/postgres/software/registry.ts)                           | Historical package, release, file and dependency models.                                         |
