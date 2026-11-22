# Launcher and Overlay

The Windows x64 desktop Launcher imports local games, prepares a selected Minecraft Java and loader release,
and owns game sessions, local saves and installed add-ons. Overlay is an independently
startable Rust host for a bundled React panel over the active game window. Windowed and borderless modes are
supported targets.

Launcher can export completed process periods for REZICS Footprints.

## Desktop ownership

[Launcher](../apps/launcher) owns Electron Main, preload actions and the React desktop interface.
[Launcher core](../packages/launcher-core) owns local files, session identity and game adapters. Minecraft
downloads official game and runtime assets through XMCL and signs in through the REZICS Microsoft public
application. Minecraft entitlement and profile checks precede launch. The instance owns its worlds and mods.
Electron and the [headless command](../apps/launcher/README.md#headless-launcher-host) compose the same
host and acquire one write lock for the local library. Headless callers can inspect or import a batch of visual
novels, use explicit Subject IDs, and call the same typed core operations and Overlay controls from a module.
A running desktop or terminal host accepts the local library and VN automation commands on loopback.
Its private profile descriptor and per-connection challenge authenticate both peers. The host serializes
automation imports, publishes successful installation changes to the desktop, and drains accepted operations
before releasing ownership. Local script execution uses an exclusive host.
The command-line entry accepts a JSON file or one piped JSON value for automation commands with a JSON
argument. The explicit `-` argument reads up to 16 MiB of UTF-8 input before opening the profile. Relative
paths resolve from the command's working folder for piped requests and from the JSON file for file input.
The command manifest identifies which commands accept piped JSON. `read-library` keeps its query in a
file and reserves standard input for the REZICS credential. Both input forms use the same profile and
review checks for automation.
[VS Code explicit standard input argument](https://github.com/microsoft/vscode/blob/60385084191c4017b47890036eabef4a92e1b570/src/vs/code/node/cli.ts#L268-L285)
The Windows installer includes `rezics-launcher-host.exe` as a console executable that can start the same
host without Electron. The desktop and packaged command read the same shipped Microsoft public-client ID.
Folder discovery reuses local engine inspection and reports each directory's candidate executables and
matching existing instances. It continues into nested directories beside a recognized game. It skips only
the content and runtime directories identified by that game, as well as linked directories and the Launcher
profile. Ren'Py contributes its resolved content directory and bundled `renpy` and `lib` directories. When
the package root contains the scripts, its local `saves` directory is skipped. KiriKiri contributes its
resolved loose content directory and standard `system`, `plugin` and `plugin64` directories. An archive-only
KiriKiri installation can have independent games next to its archive.
[Ren'Py content resolution](https://github.com/renpy/renpy/blob/5444c2dfed103a6300d1cb9f299900a5c6d1adb3/renpy.py#L40-L92) ·
[Ren'Py distribution runtime](https://github.com/renpy/renpy/blob/5444c2dfed103a6300d1cb9f299900a5c6d1adb3/launcher/game/distribute.rpy#L1286-L1287) ·
[KiriKiri plugin locations](https://github.com/krkrz/krkrz/blob/fd5c4baa6a2ef5978db1bd043634351f48667daf/base/win32/PluginImpl.cpp#L540-L551)

The Host reports `platformMatch` for Windows executables on Windows and for scripts with execute permission
on other platforms. A Ren'Py executable or shell script can identify its entry point through a same-stem
Python bootstrap. A KiriKiri executable can supply entry-point evidence through its own embedded XP3 archive.
The Host recommends an executable when there is one eligible candidate or when only one of several eligible
candidates has entry-point evidence. Registered games, scans with errors and equally supported choices
remain for explicit review. All examined candidates remain in the scan.
[Ren'Py distribution filenames](https://github.com/renpy/renpy/blob/5444c2dfed103a6300d1cb9f299900a5c6d1adb3/launcher/game/distribute.rpy#L678-L683) ·
[Ren'Py bootstrap](https://github.com/renpy/renpy/blob/5444c2dfed103a6300d1cb9f299900a5c6d1adb3/renpy.py#L284-L304)

Agents choose entries for the separate import operation. Desktop folder imports
and agent batches use the same Host queue and reuse an existing installation when its executable and working
folder match. If one selected game fails validation, the other selected games can still be registered.
Agents can update the Subject associations of existing visual novels in a batch. Each change checks the
expected Subject ID under the instance lock. A conflict returns the current instance and a retry with
the desired association already in place succeeds without writing. The local change keeps save history.
An agent can submit up to 100 ordered queries with `search-vn-batch`. Each query accepts the same title,
Subject ID or canonical REZICS URL as `search-vn`. Results keep the input index and report matches, an
empty match list or a row error. Equal trimmed queries share one lookup, up to four distinct lookups
run concurrently per batch, and interruption cancels the in-flight lookups. The batch sends query
text or a Subject ID through the shared public Subject client. The agent chooses which results to
apply separately through `link-vn`.
Launcher opens to Library with REZICS online selected. The online view opens the existing REZICS Web Library
for sign-in and browsing. The Installed filter shows this device's installations, including games awaiting a
Subject link. The local Subject link joins the records on the device. Agents can use available, authorized
REZICS CLI or MCP operations for online records and pass selected Subject IDs to the Launcher host for local
work. The host also supports an authorized shelf read directly.
An authorized host caller can also read visual novel and video game shelves with the shared Kernel client.
The typed shelf route requires `library_entry:list` and `progress_session:list` and the corresponding Kernel
exposure gates. [Kernel shelf authorization](../services/kernel/src/library/shelf-admission.ts)
The native page and cursor come from REZICS. The command uses its caller-provided credential in its own process
and joins the installation list from the running host when the profile is open. Only the installation list
request crosses the automation connection. Installed is applied locally. A page with no matching installs can
still have a continuation. If the profile cannot supply its installation list, the unfiltered read keeps the
authorized entries and cursor and marks the installation annotations unavailable. The Installed filter requires
the installation list and reports `installations-unavailable` when it cannot read it.
The Kernel's basic shelf view supplies the same typed query when the full view reports `semantic_not_ready`.
Launcher keeps the authorized Subject IDs, cursor and local matches and marks the response's metadata unavailable.
An installed Launcher reads the Microsoft public-client ID packaged with the candidate. Development Launcher
can take the ID from its environment. Windows qualification binds the packaged client file to the other
candidate artifacts and requires an approved application for the licensed checks.
The host can force stop the current game after explicit confirmation. A stop request is bound to its exact live
session and child process.
Through the desktop or terminal host, the command line can start an installed game, read the live session
and Overlay status, read filtered launch diagnostics, and stop the exact session. Overlay restart and
shortcut changes use that session ID and the same sidecar bridge as desktop.
[Game session commands](../apps/launcher/README.md#game-sessions-without-a-window)
Quit from the tray offers to wait for a starting or running game. The player can cancel the scheduled quit
from the tray. Once the game closes, Launcher finishes
its launch report, automatic save backup and session recording before quitting. A quit requested while this
work is finishing waits for it directly.
The terminal host accepts `quit-host` through its own authenticated automation connection. It schedules
exit after the current game and its after-exit work, including report, backup and session recording, and
after any accepted Minecraft preparation. While it waits, the agent can inspect or stop that exact
session, inspect or cancel a preparation by attempt ID, and read the library, backups and diagnostics.
Other new operations are rejected while quit is pending. A termination signal delivered to the
terminal host follows the same shutdown path. The host releases the profile after its Overlay sidecar
closes, so a replacement host can register the shortcut.
A Visual Novel uses an imported executable and working directory. Local preview reads literal Ren'Py title,
version and save-directory declarations from the resolved content folder's options file. A standard Ren'Py
package uses its executable's folder and checks the executable name and its space or underscore suffixes,
then `game`, `data`, `launcher/game`, and the package folder. Inspection can use the selected working folder
for a layout without the packaged runtime marker. The bundled `cache/build_info.json` in the content folder
can supply a missing title or version, including for releases that contain only compiled game scripts.
A chosen save folder overrides automatic discovery. Launcher can otherwise check `saves` in the resolved
content folder and the per-game Ren'Py folder using a user-specified or literal save name when available.
The named folder follows the game process's `RENPY_PATH_TO_SAVES`, then the nearest `Ren'Py Data` folder
at or above the executable's folder, and then the platform's default Ren'Py directory. Import and Overview
show the resolved folder when available. A missing save folder can be identified before the game creates it.
For Windows KiriKiri, Launcher recognizes loose KAG projects and standard XP3 archives in `data.xp3`,
a companion `data.exe` or the selected executable. The reader follows the engine's data source
priority. It scans the first 256 KiB beyond the executable sections for an aligned embedded archive.
Loose scripts and small, unprotected XP3 entries can supply a literal `System.title` from
`system/Config.tjs`. A standard archive header can still identify the engine when the scripts are
unavailable. The game-local save root can come from a literal relative KAG save path or an
executable-relative `datapath` in the executable's `.cf` file. The detected directory joins the existing
local backup flow. Use the save-folder picker for other locations.
[KiriKiri startup order](https://github.com/krkrz/krkrz/blob/fd5c4baa6a2ef5978db1bd043634351f48667daf/base/win32/SysInitImpl.cpp#L1088-L1159)
[XP3 reader](https://github.com/krkrz/krkrz/blob/fd5c4baa6a2ef5978db1bd043634351f48667daf/base/XP3Archive.cpp#L226-L521)
[Windows executable section layout](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#section-table-section-headers)
The Overview shows detected information after import. Settings lets the player choose a relocated executable,
change the working or save folder, rename the entry and update its REZICS association. A missing executable links
to Settings from the launch report. The instance keeps its ID and save history. Launcher recovers interrupted
restores against the previous roots before changing the settings, and restore previews use matching root IDs.
The Host CLI reads and edits visual novel settings in batches. Each reviewed edit carries the local settings
revision and keeps the installation ID and its backups. A replay returns unchanged when the desired values
are already saved. A conflicting edit reports the current instance and revision. The desktop refreshes
settings after CLI changes and preserves a draft for review if the saved settings have changed.
[Visual novel settings commands](../apps/launcher/README.md#visual-novel-settings-without-a-window)

[Overlay](../apps/overlay) owns Windows window selection, hotkey, focus, bounds and input. There is one active
Launcher game session. The [shared contract](../packages/launcher-contract) sends its current snapshot as a
versioned bounded JSON line over Launcher-owned pipes. The matching sidecar accepts 32 KiB of session data,
and actions and status replies remain limited to 16 KiB. Only the Launcher resolves REZICS destination IDs to
URLs. Closing the Launcher window leaves the tray and session active. The active game panel lets the player
choose `Ctrl+Shift+Space`, `Ctrl+Shift+F9` or `Ctrl+Shift+F10`. Launcher saves the choice locally and replaces the
Overlay process for the current game. Extensions and the Host CLI also expose the shortcut and the option to
start Overlay with games before a session begins. Disabling Overlay releases its sidecar and shortcut while
the game continues. Enabling it during play attaches to the current session. The profile keeps both choices
across restarts. Existing profiles start Overlay unless the player disables it.
When registration fails, the panel names the attempted shortcut and offers
another choice or a retry. Overlay confirms the registered shortcut and game attachment before reporting ready.
A failed attachment or WebView2 initialization also offers a manual retry while the game continues.
When the WebView2 loader detects a runtime version after an initialization failure, the game panel reports
the startup failure and the Host returns `webview2-startup`. A failure without runtime confirmation can
open Microsoft's runtime download page from the active game panel.
Launcher retries one unexpected exit automatically. If WebView2 loses its main renderer or browser process,
Overlay hides the panel, returns focus to the game when it still owns the foreground, and exits for the same
session retry. GPU and utility process recovery stays with WebView2. Players can restart a ready Overlay from
the active game panel. The Overlay uses local assets and presents only built-in and declarative content.
After the sidecar process exits, Launcher briefly drains its diagnostic frames and closes its pipe endpoints.
A descendant still holding a pipe cannot delay restarting Overlay or releasing the Launcher profile.
[WebView2 process recovery](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events)

## Shared desktop UI

The Launcher and Overlay consume the shared REZICS design tokens and reusable React controls from
[`@rezics/ui`](../packages/ui). The desktop shell owns tray, window and session affordances. The Overlay owns
its transparent composition and input modes. A pinned HUD hides while the game is minimized or in the background
and resumes over the same foreground game window without activating the Overlay. Interactive mode closes when its
top-level window loses activation. A game-owned modal prompt keeps its own focus and suspends a pinned HUD until
the game window returns. The Overlay shortcut cannot open an interactive panel over that prompt.
Placement uses the full client rectangle in screen coordinates. A mirrored window's layout and Windows-managed
scaling leave the Overlay attached to the drawn client area when the game moves or resizes. For a foreground
topmost game, Overlay tracks the stacking order even when the client area stays the same. A pinned HUD stays
above that game and keeps passing pointer input through.
Moving focus within the panel keeps it open. Each opening starts keyboard focus at
the game title, and only commands from that opening can close it, pin it or open a destination. Panel updates within
an opening keep the current focus. Both desktop apps build their frontend assets locally from the workspace.
The Windows packager checks the x64 Overlay executable before creating a candidate. It reads the PE import
table and includes the adjacent x64 `WebView2Loader.dll` when the Overlay imports it. The pinned WebView2
bindings use that DLL on GNU targets and statically link the loader on MSVC. A missing or incompatible
required DLL stops packaging before the Windows candidate is created.
[Windows PE import directory](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#import-directory-table) ·
[WebView2 binding linkage](https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/crates/bindings/src/lib.rs#L12-L23)
The Overlay build stages the loader beside the Windows executable using the artifact and build-script output
paths reported by the same successful Cargo invocation. This works when Cargo reuses those outputs and when
the build uses a separate target directory. Overlay overrides still need the companion DLL when they import it.
[Cargo build messages](https://doc.rust-lang.org/cargo/reference/external-tools.html#json-messages)

The VN importer keeps filesystem discovery in the desktop host. Its REZICS association requires an explicit
choice of a public visual novel Subject. When local inspection finds a title, the player can search
that title with one action. Inspecting the installation does not start a search. Typing or clearing another
search keeps the existing association. Selecting a result or explicitly removing the link edits it. The picker
uses the shared EntityPicker and public Subject APIs through [`@rezics/client`](../packages/client).
Pasting a Subject ID or a canonical Subject page link from the configured REZICS website reads that exact public
entry and shows its title for selection, even when the title index is unavailable. The client extracts the
ID from the link before making the request. Settings reads the public title for the exact ID stored on the
instance. Both operations follow the shared locale chain so a related translation can appear before the
English fallback.
If the title cannot be read, the existing link and local settings remain usable. The local paths and saved
files stay in the desktop host. Clearing or replacing the query, leaving its page, or reloading the window
cancels the outstanding lookup.
From Library's Installed filter, the bundled visual novel importer can scan a selected games folder and preview the detected
installations. It preselects the recommendation from the Host for review and keeps other eligible choices
available. Unknown games remain available through single game
import. The host accepts selections from the current scan and rechecks their paths before registering them.
The scan identifies archived matches and shows their original local instance. An import of that match
reports its archive state so an agent can restore it with its existing ID.

An imported game can be archived from its game page or through a batch Host command. Installed drops the
archived instance from the device view. The archive holds its settings, REZICS Subject link, and Launcher
backup history. The executable and live saves remain at their original paths. Restore from Archived instances
or use the Host command to return that same instance to Installed. The host rejects attempts to archive a
running instance and accepts retries when the requested archive state is already in place.

## Bundled plugins

First-party plugins ship with Launcher. A shared declaration identifies the plugin and its contributions. The
desktop build compiles its React and main-process entries separately. React contributions consume components
and theme tokens from `@rezics/ui`, and receive a typed slice of the existing desktop bridge. The backend
uses explicit host ports. The host owns the file pickers, account secrets, instance locks, process lifetime
and Overlay session. A plugin can declare a Library panel or observe a completed game session. A session
observer selects whether to record before launch and receives the wall-clock start and monotonic duration
after the host observes process exit.

To add a bundled plugin, declare its contributions in the shared manifest and register its React, desktop main
and core entries. The manifest determines the available panels, instance forms, import fields and session hooks.
A local import contribution supplies the fields for its game kind and converts their draft options into the shared
import input. Add a desktop command's signature to the typed desktop API and implement its handler in the
plugin's desktop entry. Declare the command name in the plugin's manifest. The same name registers the main
handler, generates the isolated preload call and makes that call available to the plugin's React contributions.
The main entry validates renderer input and receives host ports for actions such as picking a path or writing to
the clipboard. Host commands and desktop subscriptions remain available to the contributions through the typed API.
Declare headless commands in the same plugin manifest with their input form and any running-host requirement.
Register the matching handlers in the Host registry. The registry checks that declared and implemented names
match and that command names are unique. The terminal help and the versioned JSON command list use these declarations.
[Manifest](../packages/launcher-contract/src/bundled-plugins.ts) ·
[React registry](../apps/launcher/src/plugins/builtin-plugins.ts) ·
[Desktop main registry](../apps/launcher/src/main/rpc.ts) ·
[Host command registry](../apps/launcher/src/main/automation-commands.ts) ·
[Core registry](../packages/launcher-core/src/plugins/builtin-plugins.ts)

Minecraft, visual novels and launch diagnostics use the same static frontend and main-process registries.
The Minecraft plugin contributes its instance form, account controls, preparation, Java settings, mods and
packs together with the Minecraft backend adapter. The visual novel plugin contributes its Overview, Settings,
and the local import fields for Ren’Py inspection, save options and Subject lookup. The shared import form
owns common paths, the game name and submission. Diagnostics contributes the Logs panel and one bounded
local report per instance. It masks the Minecraft token before retaining output and records the exit status.
Recognized failures can open the relevant accounts, installation, settings, mods or packs panel. Copy diagnostics
puts a bounded report on the local clipboard after filtering common credentials and known local paths. The Kernel
catalogue supplies declarative Overlay panels and game artifacts. Bundled executable plugins ship as part
of the Launcher build.

An open Logs panel follows the selected instance's launch report, including failures before a process starts
and reports that finish draining output after the process exits. Desktop and Host CLI launches use the same
report. The diagnostics plugin notifies the desktop with the instance ID, and the panel reads the updated report
through its existing command. Prism also keeps an open instance log bound to its launch task.
[Prism log page source](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ui/pages/instance/LogPage.cpp#L206-L226)

After a Minecraft process closes, Launcher can attach a bounded excerpt from a new report in that
instance's `crash-reports` folder. Launcher records which files were present before starting the game
and checks the standard crash report header. A new report marks the launch as failed even if the
process returned exit code zero. The report retains the actual exit code. An explicit Stop records the
process exit and skips crash diagnosis. The Host and Logs panel show the same evidence and recognized
recovery action. Copy diagnostics includes the excerpt within its existing size limit and applies the
same credential and path filtering. An unreadable report leaves process diagnostics available.
[XMCL launch result](https://github.com/Voxelum/x-minecraft-launcher/blob/14b1ac11e52377ee0ab34f5485d1e2758495b34f/xmcl-runtime/launch/LaunchService.ts#L614-L658)

Game Footprints contributes its opt-in and export controls to Installed and the Host CLI. Its backend records
completed Subject-linked runs through the session observer. The CLI uses the same local settings and export
format, and the desktop reflects CLI changes to the recording setting.
[Footprints commands](../apps/launcher/README.md#game-footprints-without-a-window) ·
[Local capture](../packages/launcher-core/src/plugins/game-footprints.ts)

## Minecraft maturity

The Windows x64 maturity target is the complete common Java player journey. A player chooses and retains an
exact game version, compatible loader and Java policy per instance, signs in, installs or imports into an
isolated instance and enters a world. They can see progress and errors, cancel and retry an install, repair
files with verification, relaunch an existing instance, manage compatible mods and a Modrinth pack, and
restore a chosen world while keeping sibling worlds and instances separate.

Each instance records its installation, repair or version change. The desktop host publishes the current phase
and cancellation state. Libraries and game assets have separate phases with counts of completed checks.
The asset count includes each distinct asset once, including valid cached files. The Launcher keeps active
preparations visible across pages and after a window reload, and opens the relevant instance from each entry.
A queued job shows that it is waiting for shared files. If a different Minecraft instance is running,
the first job in the queue waits for that game to close and then starts automatically. Players can cancel
while waiting for either the game or shared files. Cancelling work already writing files waits for it
to stop before releasing the installation lock. Minecraft launches wait for preparation to finish before
Play becomes available.
A retry reuses verified files. After a restart, the activity sidebar opens an interrupted attempt's installation
or version controls. Launcher reads the saved attempt ID and recognizes an install, repair or version change
already committed before the interruption. A successful verification records the launchable version and its
Java requirement. The managed Java policy
uses the game release's runtime metadata. A player can choose a local Java executable and a memory limit for
an instance. The host verifies the executable's Java major and architecture when saving the choice, including
for an instance that has yet to be installed. An installed instance uses its recorded Java requirement. A new
instance reads the exact release's metadata without downloading assets or the game. Settings and the Host CLI
can check the selected Java separately. The check reports a compatible runtime, the need for initial
preparation, or an actionable repair or setting change. Managed Java uses the same runtime verification as Play.
Changing the settings leaves the game's installation and save files in place.
Before contacting the account service, Launcher checks the cached client, libraries, asset index and logging
configuration needed for launch. Preparation saves the exact version and loader descriptors in a shared
cache addressed by their digests. Play verifies those copies and resolves their version chain from the
checked bytes. Verify and repair creates the same record for older instances. Play also verifies the
published size and hash of every distinct indexed asset and
each regular file in the installed managed Java manifest. The manifest must match the digest recorded for the
instance before Launcher runs managed Java. Preparation and Play restore missing directories, published
runtime links and executable permissions. Play restores this layout from the verified cache before probing Java,
so an existing installation gets the same layout without downloading the runtime again. Older releases that
read virtual assets get a named copy of each asset from the verified download cache. Preparation and Play
fill missing names and replace damaged copies or old hard links. Editing a named copy leaves the downloaded
object available for repair. For Forge and NeoForge, Launcher verifies the generated loader files against the
exact output list captured during preparation. The installation records the output list's digest, so a missing
list or a change to its entries also opens repair. Older installations use their existing
list until the next verification or repair saves the digest. A damaged or missing resource opens installation
repair from the launch report. An unusable managed Java runtime leads to repair, and a custom Java problem leads to
the instance's Java settings.
Each launch extracts the selected platform's native libraries from checked archives into a new temporary
directory. Failed preparations and finished Java processes release their own directory. Play can therefore
recover when an older extracted cache is incomplete or blocked.

Fabric preparation retains the library sizes and SHA-1 digests published in the profile. For a library
without an inline digest, it reads the checksum on the official Maven repository. Both installation repair
and Play use the resulting checksums. Verify and repair adds them to previously prepared Fabric instances.
For libraries with a published SHA-1, preparation tries the provider URL first, then the two official Maven
Central HTTPS endpoints. Each attempt starts with an empty staging file and must match the original checksum
before it can replace a cached library. The same rule applies to Forge and NeoForge installer dependencies.

Players can rename and duplicate an instance from its settings. A duplicate has its own game folder, mod and
pack state, and optionally copies the current worlds. Both instances can reuse verified common game downloads.
Removing an instance from the library moves its files and backup history to the local archive so it can be
restored. Players can permanently remove an archived instance after a separate confirmation.
The Host CLI uses the same instance lifecycle. The archive listing returns a revision for each row.
Permanent deletion checks that revision before removing the archived instance. Restoring and archiving
an instance again creates a new revision. The desktop refreshes Installed and the archive after a CLI
change, and returns to Installed if the open instance is archived.
On Linux and Windows, duplication, version copies, pack imports and archive moves publish only to a free
instance directory. A directory created during staging stays in place, even when empty. Launcher clears
its unpublished copy or import so the operation can be retried. Linux reuses the same exclusive directory
operation as world import.
[Minecraft instance commands](../apps/launcher/README.md#minecraft-instance-management-without-a-window)

A version change prepares and verifies the exact requested selection before publication. Failed or cancelled
work leaves the previous instance available. Applying the selection to the same instance requires an instance
without installed mods, a modpack or unmanaged mod files. The version picker checks the instance when the
player selects a change. It explains when mods, a modpack or worlds in a downgrade require a separate copy.
Preparing a copy stays available while the in-place check runs or needs a retry. Launcher takes a backup of
its existing worlds before changing the selected version. When preparing an independent upgraded instance, players can copy all
worlds, choose individual worlds or start with no worlds. The copy carries the account choice and memory limit.
A version change can keep the instance's current Java, use managed
Java for the selected version, or use an executable chosen with the desktop picker. Launcher verifies Java for
the destination release before publishing the selection or copying worlds. An explicit runtime choice remains available
when retrying a failed or interrupted change. The choice takes effect with the prepared version, and a separate copy
keeps the original instance's Java settings. Launcher rechecks the selected world directories before copying
and retains the choice for retry after a failure or cancellation. When switching to an earlier stable release,
an instance with worlds requires a separate copy. An in-place change also requires a separate copy if a saved world
records a newer stable release than the destination. Launcher rechecks the applicable in-place restrictions before
preparing the release and again before applying it. The version picker starts a downgrade copy with no worlds.
Version copies and separate Modrinth pack instances compare the selected worlds' recorded releases with the
destination. A player can confirm the warning before preparing the copy. Launcher checks again before publishing the
staged worlds. Minecraft determines whether a world can open in a given version.
The Host CLI uses the same checks and preparation process. It previews the exact current and requested
selections, selected worlds, Java policy and any blocker or version warning. Starting a reviewed change
rechecks those choices and admits the attempt against the reviewed source selection. The existing preparation
events keep the desktop current when an agent makes a change.
[Minecraft version change commands](../apps/launcher/README.md#minecraft-version-changes-without-a-window)

Players can save several Microsoft Minecraft profiles when the host has protected storage. They choose a
default profile and can select a different saved profile for an instance. The host keeps tokens encrypted,
checks the game's entitlement and profile, and can reuse a verified Minecraft token until it expires. Reconnect
requires the same Minecraft profile. Expired credentials require authorized online renewal, and a failure on
one profile leaves other saved profiles available.
Launcher starts polling for device authorization when it displays the Microsoft code. The desktop host
keeps the pending sign-in while the window reloads or the player moves to another page. Returning to an
instance's account panel shows the same code, the saved result or an actionable error. A player can cancel
before the profile is saved. Cancelling stops the authorization and leaves saved profiles available.
The Minecraft plugin exposes the same release selection, Java policy, account authorization, install, repair
and progress through the profile's host CLI. Preparation cancellation uses the selected attempt ID. The account
holder completes sign-in through Microsoft's verification page. A terminal-owned host retains authorized
profiles in memory until it closes. [Minecraft commands](../apps/launcher/README.md#minecraft-without-a-window)

The game picker labels the latest stable release from Mojang's catalogue. Selecting it pins its exact version
to the instance. Forge uses the exact Minecraft release group from its official catalogue starting with the
Java 17 generation. NeoForge maps exact releases from Minecraft 1.20.2 onward to its official version lines,
including the full version prefix used by 26-series releases. The existing 1.21.1 and Fabric 0.16.14 defaults
remain available when the catalogue is unavailable.
Forge and NeoForge preparation verifies the official installer checksum and resolves its client profile under
shared resources. Launcher uses the Java major required by the selected release and checks the resolved loader
profile against it. It checks published hashes when provided and records generated output hashes as each step
completes. Repair reuses verified files and restores the output record for the installed loader profile.
The pinned XMCL transfer package explicitly uses its npm Undici entry in both module formats. The Bun host
otherwise resolves the bare import to its runtime facade, whose stream API cannot download the game files.
The launcher-core suite exercises the actual XMCL metadata and client download with published fixture hashes.

Qualify the current stable Vanilla lane, Fabric on 1.21.1, Forge on 1.20.1, and NeoForge on 1.21.1 with exact
releases. Record Windows packaged results for initial installation, authorized sign-in, world entry, failure
recovery and second launch in each lane. Java requirements come from the game metadata and the supported
loader combination.
See the [maturity comparison](research/minecraft-launcher-maturity-codex.md) for source and acceptance detail.

A [Modrinth archive](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) preview
shows the game's exact version, loader and the client files that will be installed.
The user can choose a local archive with the native picker or browse Modrinth and select an exact release.
Launcher verifies the published hashes of remote archives, then asks the user to confirm the same preview
used for a local archive before it changes game files.
The Host CLI can perform the same local or online pack operations. Its preview revision binds the archive
digest, destination, requested world IDs and Java choice. Install rechecks those choices and the bytes.
Interrupting the CLI before publication cancels staging, including when the desktop owns the profile.
[Minecraft pack commands](../apps/launcher/README.md#minecraft-packs-without-a-window)
Import creates a new instance. Applying a different pack release to an existing instance requires the same
exact Minecraft and loader versions. A new instance uses managed Java by default. The pack preview also accepts
a local Java executable through the desktop picker. Before publishing, Launcher checks its major version and
architecture against the target release. The same preview keeps the choice available after an error or cancellation.
Updating a pack in place uses the instance's configured Java. Staging and recovery apply changes to pack-owned files and protect saves,
other instances and independent mods from replacement. Required resources are checked against both manifest
digests. Optional and server-only resources are listed when present and skipped for the desktop client.
Updates keep edited `options.txt` and `config/` settings, including settings that predate the pack. New and
unchanged settings take the new pack defaults. Repair checks downloads as before, and a portable export uses
the packaged defaults.
Players can cancel while Launcher stages files or copies selected worlds. Launcher stops the work and clears its
staging area before offering a retry of the same preview. Once publication begins, the existing journal or
atomic instance rename controls completion and recovery.
If an external edit or a newly occupied path stops publication, Launcher rolls back the changes it already
made and keeps the external files. Recovery verifies staged file identity before removing a published file.
If the original has already moved into staging and an external file blocks its return, both files are kept.
Launcher recovers the other paths immediately and can finish the blocked restore once the path is free.
Play checks the installed pack's required downloads. When a file is missing or damaged, the launch report
opens the Packs tab. Repair pack uses the saved manifest for the installed release without asking for the
original archive. It verifies replacements against both published hashes, restores missing overrides from
their verified originals and preserves existing override edits, independent mods and worlds.
A player can install a pack into a separate instance and choose which worlds to copy from the closed source
instance. Launcher installs the pack and copies those worlds before publishing the new instance. The source
pack, mods and worlds stay available. The new instance carries the source account choice and memory limit.
Minecraft determines which copied worlds its target version can open.
A portable export carries the exact versions, pack references and original client overrides. Exports keep
the user's local changes and saves outside the archive.

## Local saves

Players can back up an instance or a selected Minecraft world, see the history and choose what to restore.
The headless command can list worlds and backups, create a checkpoint, and preview and apply a reviewed
restore through the host that owns the profile. It can also pin or delete snapshots and export or import
portable bundles. It uses the same version, destination and game-closed checks as desktop. A successful
change refreshes Save history for the affected instance in an open desktop window.
[Backup commands](../apps/launcher/README.md#backups-without-a-window)

With the game closed, players can preview a Minecraft Java world folder or ZIP and import it under an available
folder name. When the source name is taken, the preview suggests the next available suffix, including when
the only difference is case or Unicode normalization. An explicit name stays fixed through review. The host
checks the destination again after staging. A conflict asks the player to choose another name.
Linux publishes the exact destination with glibc's `renameat2(RENAME_NOREPLACE)`. This claims the name
and moves the staged world in the same filesystem operation. A filesystem that cannot perform that
operation returns an error and preserves the destination. The standalone Host uses its bundled Bun
runtime. The Linux development desktop uses a small helper built with the desktop and run by the
workspace Bun.
[Linux rename semantics](https://man7.org/linux/man-pages/man2/rename.2.html#DESCRIPTION)
Launcher's import staging and the new world location must be separate from the source. The host checks
these paths again before clearing the staged world. Files alongside the staged world are preserved.
A folder must contain `level.dat` at its root.
A ZIP can contain it at the archive root or within one
world folder. Launcher checks the source again when importing and stages an independent copy before publishing
it. The preview reads the stable release name recorded in `level.dat` when available. Importing a world saved by
a newer stable release shows both versions and requires confirmation. The host rechecks the source and the
destination version before copying. Worlds without a recognized release name can still be imported. Close the
source game in its launcher before copying an external folder. An imported world is immediately
available for backup or export as a standard ZIP. The archive and expanded world each have a 2 GiB limit.
Runtime lock files are skipped. Minecraft and its mods determine whether the world can open in the destination version.
Desktop offers Cancel transfer while inspecting, importing or exporting. The Host CLI uses Ctrl+C for the
same operations. A cancellation encountered during reading, staging or compression closes the transfer and
clears its staged files. A cancelled import keeps its preview for retry. Once publication starts, the
final rename or link determines the outcome. An earlier completed transfer remains available.
[Prism world transfer task](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/minecraft/WorldTasks.cpp#L31-L68)
The Host CLI accepts an explicit folder or ZIP and a destination instance. Its review records the local
source, inspected revision, destination release and requested folder name. The apply command rechecks the
reviewed source and release without reopening the preview and publishes the world under an available name.
Imports refresh the world list when the desktop owns the profile. The export command writes the same
portable ZIP as desktop.
[Minecraft world commands](../apps/launcher/README.md#minecraft-worlds-without-a-window)

Game exit schedules an instance backup even when the process reports a failed exit. Launcher shows the
backup while it runs and provides a retry in Save history if it fails. Manual backups leave the last
automatic result in place. Play remains available when snapshot storage is obstructed. Launcher recovers
live restore transactions before starting the game.
When none of the instance's save folders exists yet, the automatic backup creates no checkpoint. A previous
storage or read failure remains visible until an automatic backup succeeds. Older records that reported the
missing-folder message as an automatic failure are read without that warning. An explicit backup or retry
still reports when it cannot find a save folder. Ludusavi also skips planning a backup when its scan finds
nothing to process. [Ludusavi backup planning](https://github.com/mtkennerly/ludusavi/blob/c4c2ca9943e841a7c052a59e9757535e77e80e0a/src/scan/layout.rs#L1041-L1059)
The Host CLI reads automatic backup status for a batch of installed games. A row can report idle, running,
failed with a recovery message, or an invalid instance. A caller can retry an automatic backup for a closed
game and read its resulting checkpoint. The retry updates the same status and history shown in Save history.
Automatic backup reuses the preceding automatic snapshot for that instance when the save roots, their contents
and the Minecraft version, loader and enabled mods still match. Launcher reads both the live and stored files
before reusing a snapshot. It creates a new checkpoint when the preceding backup is missing or damaged.
Manual backups always record a new checkpoint. Automatic backup leaves earlier checkpoints available for restore.
Restore requires the game to be closed and creates a recovery
snapshot for any live save roots it will replace. For a world restore, the recovery snapshot keeps that
world scope. The preview compares the destination with both the recorded instance version and the newest stable
release found in the backed-up worlds' `level.dat` files. It shows the newer version that requires confirmation.
Restore checks the versions against the staged backup before creating the recovery snapshot or replacing files.
The game determines actual world compatibility.
New local backups and imported backups keep a SHA-256 for each save root. Restore checks the copied files,
paths and empty directories in staging before it backs up or replaces live saves. Export checks the same
record before writing a portable backup. Older local backups can still be restored using their recorded file
and byte counts. If verification fails, the current saves and the backup remain available. Hashing reads each
file once as it is copied. Listing backups reads only snapshot metadata. New backups retain the world release
summary for previews. Older Minecraft backups read only the applicable `level.dat` metadata for this comparison.
Save history validates each local snapshot record independently. An unreadable record keeps its directory
and appears with its ID and issue alongside the readable backups. Records with file counts and no digest
remain readable. History reads only metadata and remains available while a live restore journal needs
attention. The Host CLI's `list-backups` keeps its array of readable records and `backup-history` returns
both the records and their issues.
Staging and a journal keep interrupted restore operations recoverable. Recovery checks every
journal entry against the instance's configured save roots before changing files. New restores record the
identities of the original and staged directories so a directory replaced outside Launcher is preserved
for review. Valid journals from earlier builds recover against the same configured save roots.
On Linux and Windows, restore and recovery move save directories only to vacant destinations. Recovery
returns a partially applied save to staging before moving the original back. A destination created
after a check keeps its files and leaves the journal available for retry. Snapshots and portable exports
use the same exclusive directory operation when they publish their completed data.

Players can pin a backup they want to keep, unpin it and explicitly delete an unpinned backup. An export
writes a new portable backup folder inside the selected directory. An import validates
the manifest, payloads and receiving instance before adding a new snapshot to history. It does not write
live saves. Players can preview and restore the imported backup through the usual save controls. Portable
data identifies save roots and world scope independently of their machine paths.

Visual novel imports retain each recognized save folder in the portable backup. The restore preview selects
matching folders and lets the player choose a new destination from the receiving instance's configured folders.
The player can leave any source folder in the backup and choose a distinct destination for each folder to
restore. The preview shows the exact targets. The desktop restore requires a current preview for those paths
and the identities of existing folders. The host rechecks the configured destinations before committing the
staged files. A changed destination requires another preview. The recovery backup contains the live folders
the restore will replace.

## Online package distribution

REZICS owns curated package identity, releases and compatibility. The Kernel exposes published lists and exact
release reads. GitHub Releases and other configured HTTPS origins can own artifact bytes. The client selects
an exact release, checks compatibility and the digest, and updates the selected instance using staging and
recovery. A withdrawn release disappears from new online installs. Existing local files remain under the
player's control. The first Launcher add-on format is a declarative Overlay panel. Fabric, Forge and NeoForge
instances can browse and install exact versions from Modrinth and import local JARs with compatible metadata.
The curated REZICS Minecraft releases target Fabric. See the
[Kernel catalogue contract](../services/kernel/src/launcher/README.md) for publication and withdrawal.
General dependency solving, third-party executable extensions, binary hosting and cloud save synchronization
are future capabilities.

Modrinth mod and pack operations share the profile host's request state. After a Modrinth `429`, the host
uses `Retry-After` or the API reset header and reports when to retry. An interval of ten seconds applies when
neither header supplies a valid interval. An early retry returns the remaining delay locally. Catalogue and CDN
requests keep independent intervals. Service outages, missing releases and local verification failures have
distinct messages. Users retry the operation explicitly, and a failed request leaves the installed state in place.
[Modrinth rate limits](https://docs.modrinth.com/api/#ratelimits) ·
[Modrinth App response handling](https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/app-lib/src/util/fetch.rs#L265-L289)

The desktop and Host CLI browse the same categories and exact releases. Both review the planned changes
before applying them. The preview binds dependencies and artifact hashes to the selected instance and
installed state. Installation resolves the plan again before downloading. The installed list opens the
available versions for each REZICS package or Modrinth mod, and identifies the current release by its
provider ID. The review shows when replacing a disabled release will enable the replacement.
When the catalogue no longer exposes the selected, required or installed REZICS release, the command
identifies that exact package and release. For a missing requirement, review a release whose required
versions are published. A catalogue outage is reported separately from an unavailable release.
The CLI also lists installed
Overlay panels in order and uses the listed revision to enable, disable or remove the selected release.
[REZICS package commands](../apps/launcher/README.md#rezics-packages-and-overlay-extensions-without-a-window)

The Modrinth version picker previews the requested release and required managed changes before it downloads
any JARs. It shows new installs, version replacements, re-enables and reinstalls. Confirming checks the same
instance, installed state, exact releases and artifact digests again. A changed plan requires a refreshed
preview before Launcher stages files.
When a Modrinth requirement names a project and the plan keeps its already enabled release, Launcher
checks that JAR and its retained requirements using their recorded fingerprints. Older records without
a fingerprint get a presence check. The Host checks during review, before downloads and again after
downloads finish. A missing or damaged dependency directs the player to repair the named mod. A failed
check keeps the previously installed releases and leaves unrelated mod files outside this check.
[Modrinth App's installed-project handling](https://github.com/modrinth/code/blob/0444aa6d1f98d017b8bd608c06796f973093c805/packages/modrinth-content-management/src/install/mod.rs#L146-L162)

For reviewed Modrinth and REZICS installations, the desktop shows the current package, its position in the
review, and received bytes out of the published size. Separate states cover checking release metadata,
verifying the downloaded file, preparing the change, and publishing it. The desktop can cancel before
publication. The Host CLI accepts an interrupt at the same boundary. Cancelled work removes its staging
files and leaves the previous installed release and enablement available. The desktop keeps the review open for
another confirmation. Once Launcher starts writing the transaction journal, it finishes or recovers that
transaction. Prism likewise reports transfer progress and retains the old resource until the replacement
download succeeds.
[Prism resource download task](https://github.com/PrismLauncher/PrismLauncher/blob/5a52fca7e8e221a678c375775a19d2b311863aa7/launcher/ResourceDownloadTask.cpp#L92-L127)
The Host CLI can browse those releases, review and apply the same install and state plans, or import,
repair and remove managed mods. A command that changes mods refreshes the open desktop Mods panel
for the affected instance. [Minecraft mod commands](../apps/launcher/README.md#minecraft-mods-without-a-window)

The Mods panel shows missing, damaged and unavailable files managed by Launcher. Before starting a modded
instance, Launcher checks enabled managed JARs and links a detected problem to Mods in the launch report.
Enabling a managed mod can enable its installed requirements. Disabling a managed mod can also disable the
enabled mods that depend on it. When several mods need to change, the Mods panel lists their names and versions
for confirmation. The Launcher host binds the review to the instance, requested state and installed records.
If these change, review the new plan. Enabling checks the required installed releases and files, and applying
the plan puts the related state changes in one package transaction.
Repair downloads the installed release again or asks the player for the original local JAR. The operation
checks the expected bytes and mod IDs, keeps the selected release, and preserves dependency rules and
enabled state. Older records without digests get an existence check until repair or reinstall records one.
An interrupted mod change rolls back only files that match its staged copies and protects unrelated files.

The Mods folder view inspects top-level JARs for the selected loader. It identifies files using the Launcher
and Modrinth pack ledgers and shows manual files alongside pack files. It marks disabled files, skips reading
linked archives, and lists exact file names for repeated mod IDs from active archives. These results help the
player investigate loader failures. If the loader logs a duplicate-mod error, Logs opens the Mods panel.
Players can disable a manual JAR directly from the duplicate warning and re-enable it from the file list.
The Host checks the scanned file revision and uses the `.jar.disabled` name while the game is closed.
Both names of a Launcher or pack JAR remain under their package owner. The destination must be free or
refer to the same file after an interrupted change. The operation uses an exclusive hard link and then
removes the old name, preserving the JAR bytes. A rescan allows retry after interruption. Players can
open the Mods folder in their file manager, including on filesystems without hard-link support.
The CLI can scan and change manual files through the same Host.

An Overlay panel artifact is a UTF-8 JSON document of at most 16 KiB. Its title and text appear in the bundled
panel component. An optional destination is one of `info`, `guide` or `community`. New installations retain
both the published artifact digest and a digest of the saved panel content. Extensions distinguishes a missing
or damaged panel from one outside the display limit. Panels installed before the digest was introduced still
undergo shape validation. Repair fetches the exact installed release, checks its published size and digest,
and preserves its local enablement and position. A withdrawn release, changed digest, or stale repair request
leaves the installed record in place.
Overlay displays the first eight usable enabled panels in Extensions order. Players can move a panel up or
down. The Host CLI can submit the entire desired order. Both operations check the reviewed membership and
order before saving, and preserve enabled states and exact releases. Reordering, disabling and repairing
panels refresh the current session. Moving views within the same container is also supported by VS Code.
[VS Code view placement source](https://github.com/microsoft/vscode/blob/60385084191c4017b47890036eabef4a92e1b570/src/vs/workbench/browser/parts/views/viewPaneContainer.ts#L1010-L1043)
Game startup reads the committed extension ledger while downloads run. Each successful edit publishes its
committed panels to the current session. An edit that completes during the startup read takes precedence in the
first snapshot. The game and built-in Overlay controls remain available if the extension ledger cannot be read.
While a snapshot write is pending, Launcher combines subsequent updates and sends the latest state when the
write completes. A pending update stays scoped to the sidecar and its game session.

```json
{
  "schemaVersion": 1,
  "title": "Guides",
  "text": "Find guides for the active game.",
  "destination": "guide"
}
```

## Acceptance

A built Linux Electron app opened on REZICS online and sent the configured Web Library URL to the system
browser port. The Installed filter exposed both linked and unlinked games imported through the running host.
Keyboard selection kept focus on the filter. The online view was checked with a fixture Web origin.
The headless CLI read an authorized fixture shelf while the local profile was unavailable. The online page
kept its title and continuation, while the Installed filter reported the unavailable profile. With an empty,
readable profile, the filter returned an empty page and kept the same continuation.
The display-free host inspected 100 Ren'Py fixture installations, reported one missing executable separately,
and imported the selected 100. Repeating the import returned the same instance IDs. A second host received a
busy result while the first owned the same data folder. The same host returned the configured REZICS Library
URL through its external-link port.
Folder discovery found the official The Question 7.0 release and 99 Ren'Py and KiriKiri fixtures without a
display. It reported multiple executables and unknown packages, skipped links and the Launcher profile, and
reported an unreadable folder alongside its results. After the selected 100 installs were imported, it
returned their existing instance IDs.
The standalone Linux host and Windows x64 host under Wine each discovered 100 installations in a nested
collection with The Question 7.0 at its root, a packed KiriKiri game, and 98 Ren'Py fixtures. Both skipped
candidate executables inside engine content, runtime directories and the Launcher profile. Both imported the
100 selected games and returned the same instance IDs on replay and rescan. A built Linux Electron app opened
the configured online Library URL and imported a parent game and its nested neighbor through Installed with a
supplied picker result. Native Windows folder discovery remains unverified.
The Linux Host and Windows x64 Host under Wine each recommended 100 new installations in a fixture with
extra helper programs and kept a separate two-entry-point game available for manual choice. Replaying the
reviewed import returned all 100 existing IDs. The tests used The Question 7.0 on Linux and its same-stem
bootstrap with the Ren'Py Windows SDK executable under Wine. The Windows Host also recognized a packed
KiriKiri launch executable. Built Linux Electron preselected `the_question.sh`, kept the eligible helper
selectable, and left the ambiguous game skipped. Starting the imported game through the Host opened
The Question's X11 window. The recommendation review was checked in compact dark and desktop-width light.
Two CLI processes imported the same 100 games through a display-free running host and received one set of
instance IDs. The fixture also exercised discovery, inspection, linking, an unauthorized request and replay.
A built Linux Electron app refreshed Installed after a CLI import while its window remained open, persisted the
link, and released the profile on quit. Windows desktop automation has not been exercised.
Linux Electron reviewed 103 fixture folders in the batch importer with a supplied folder-picker result. It showed
the installed, ambiguous, other-platform and unrecognized cases. A game path replaced with a link after the scan
failed by itself. Desktop and CLI batch imports overlapped and produced one record per installation. The file
picker and folder-import journey have not been exercised on native Windows.
The Windows x64 NSIS payload contained the matching standalone console host. Under Wine that executable ran
without opening Launcher, loaded an external module, and used a Windows command pipe to read a fixture Library
credential. A second process discovered and imported a fixture through the serving host and returned the same
instance ID on retry. Native Windows terminal and running desktop checks remain pending.
The display-free host updated 100 associations using explicit fixture Subject IDs while the catalogue was
unavailable. Replaying the batch kept the same records. A stale edit returned the current association,
two concurrent edits had one winner, and removing a link kept local saves and snapshot history. Live
REZICS CLI and MCP integration has not been exercised by this fixture.
The display-free CLI reviewed a batch of 100 imported fixture games with the shared Subject client.
It returned duplicate titles from one lookup, kept both candidates for an ambiguous title, and
distinguished no match from an invalid query and an unavailable provider. Pasted IDs and a canonical link
resolved exact records. The selected links applied to all 100 installations and replay returned unchanged.
Interrupting a separate batch cancelled four in-flight lookups and left its pending queries unsent.
An agent inspected 100 local installations from piped JSON through a running Linux Host and supplied a
confirmed Subject association the same way. In compiled Linux and Windows console runs, a Japanese title
went from local inspection to a public catalogue fixture, repeated import kept the same instance, and a
reviewed link appeared on the fixture's authorized shelf. The shelf query used a file and its credential
came from standard input. Linux cancelled an incomplete pipe before opening the profile. The Windows
check used the exact NSIS Host under Wine with a Windows command pipe. Native Windows and a provisioned
REZICS CLI or MCP remain to be exercised for this flow.
With a migrated local Kernel and its Subject link projection caught up, the compiled Linux Host returned
two public visual novels by their exact identifiers and excluded a same-title book. The confirmed link
was then visible on the authorized online shelf with the matching local installation.
The Windows x64 installer contained the matching standalone Host. Under Wine, that Host queried a
canonical link from the running profile while another query returned HTTP 503. It kept the successful
rows, applied the selected link separately and replayed it unchanged. The batch command has not been
exercised on native Windows.
The same installer's application archive, opened in Linux Electron, defaulted to REZICS online and
opened the configured Web Library. Linked and unlinked CLI imports appeared in Installed. Keyboard
and navigation checks covered the online view in dark mode and the local view in light mode.
The display-free host also reviewed and edited the settings of 100 imported fixture visual novels.
It applied valid rows beside a conflicting edit and an invalid row, and an already applied edit returned
unchanged. A moved game retained its instance ID and Subject link and restored an earlier backup to its
new save folder. The packaged Linux desktop preserved an unsaved draft during a CLI edit and accepted
a new edit after reloading the reviewed settings. The CLI then launched the relocated official The
Question 7.0 package, refused settings changes during play and kept the earlier backup after exit.
The packaged Windows console host under Wine resolved relative settings paths and restored an earlier
backup after moving a Ren’Py fixture.
The display-free CLI archived and restored 100 imported visual novels through a running host. The
batch reported a missing ID separately and retries returned unchanged. A scan and repeated import
identified an archived game with its original ID and Subject link. Restoration kept the executable,
live save and backup history. The CLI also refused to archive a running local game and archived it
after it stopped. A built Linux desktop reflected CLI archival while the game page was open, restored
the same game from Archived instances, and marked its archived scan match. The same build used the shared
EntityPicker to put the detected title into the search field and focus it on keyboard activation. The
Linux desktop sent the configured online Library URL to the system browser port. The 14 EntityPicker
browser stories passed. The UI package type check still reported errors in CoverCard and Rating.
The Windows x64 NSIS package built from `f41e7a75db5` contained the tested console host. Under Wine, it
archived and restored a visual novel and another local game, preserved the Subject ID and backup, and
returned the archived ID from discovery and re-import. Imported-game archival has not been exercised on
native Windows. This run used fixture Subject IDs. Live REZICS CLI and MCP interoperability remains unverified.
A built Linux Electron app refreshed Save history when the CLI created and restored a visual novel backup.
The CLI read backups while the game ran and received the same game-closed error on writes. It preserved a
replacement directory when a preview became stale, then restored the backup after a new review. A separate selected
Minecraft world restore preserved the sibling world. The CLI reopened the history after the window closed.
The CLI read automatic backup status for 100 installed visual novels and returned one invalid ID as a
separate row error. A fixture game hit a real snapshot storage obstruction after exit. The running host
reported the failure and used one unchanged checkpoint on repeated retries after the obstruction was removed.
The built Linux desktop showed the same failure and refreshed Save history after a CLI retry. The Windows
x64 Host from `e4d96c8640` ran the same failure and recovery under Wine and reported a stable executable
issue after its game file was removed. This recovery flow has not been exercised on native Windows.
In the Linux desktop and Host CLI, a Ren'Py fixture exited before creating a save folder. An older
missing-folder warning read as idle, and the exit created no checkpoint. An explicit backup reported the
missing folder. The next launch wrote its first save and the desktop showed the automatic checkpoint.
Obstructing snapshot storage then produced a failure. A CLI retry reused the intact checkpoint after storage
was restored. The missing-folder case has not been exercised on native Windows.
The running-host CLI round trip exported a pinned selected-world backup, imported it under a second
instance, and preserved the second instance's live world until its reviewed restore. Deletion required
unpinning and removed only the chosen history entry.
The packaged Linux desktop reflected CLI rename and duplication while open. Archiving the open instance
returned to Installed. Restoring it through the CLI cleared its open delete confirmation and preserved its
world and backup history. A new desktop confirmation deleted the new archive entry. The Windows console
host under Wine independently refused a confirmation from before a restore and rearchive, then deleted
only the current archive and preserved the copy.
The standalone Linux Host kept the exact empty instance directory created at the publication syscall
during duplication. The Windows x64 Host under Wine kept a directory created during staging. Both hosts
cleared staging and retried successfully, then archived and restored the copied XMCL world with matching
level and region bytes. Core fixtures exercised the same conflict during a version copy and Modrinth
import. Built Linux Electron applied CLI duplication, archive and restore through its bundled helper.
Native Windows instance publication has yet to be verified.
Linux Electron reflected a CLI-started and CLI-stopped game and a shortcut change in its active session.
A fixture sidecar confirmed attachment after a restart. Diagnostics returned filtered output. In the same
desktop fixture, a portable VN import appeared in Save history, could be reviewed and restored, and
disappeared after unpinning and deletion. The source history retained its pinned backup.
The Linux desktop saved an idle shortcut and disabled Overlay from Extensions. Starting a game did not
spawn the fixture sidecar. Enabling through the CLI attached it to the current session and refreshed the
desktop switch. Disabling through the desktop retired it while the same game process stayed active.
The Windows console host from `a912725168` under Wine kept the idle choices across host start and reported
the disabled state for the running fixture game. Re-enabling the packaged sidecar reported its WebView2
failure while the game stayed active. The new settings have not been exercised with native Windows
WebView2 window attachment or focus restoration.
The Host CLI installed a reviewed Overlay panel with its required releases. A withdrawn release, a changed
published digest and corrupt artifact bytes each left the previous installed list and session intact.
Disabling an earlier panel promoted the ninth panel into the same running session. A reviewed curated
Fabric mod installed only in its selected instance. The packaged Linux desktop refreshed Extensions after
CLI installation, disable and removal, and its fixture sidecar received the corresponding panel lists.
The packaged Windows console host under Wine verified the same catalogue commands against a trusted
loopback HTTPS fixture.
The Linux desktop from `90692306b7` reviewed an extension and its required package before downloading
either artifact. Cancelling preserved the installed state. After a concurrent CLI change, confirmation
refused the stale preview without downloading again. A new review installed a different release with the
same display version and sent its panel to the running fixture Overlay. The Installed mods list opened and
applied a curated Fabric release change. For a real Fabric API release from Modrinth, it marked the exact
installed release and reviewed another compatible release. Cancelling kept the current release. The Windows
console host from the same candidate verified the exact replacement and stale-preview refusal over
trusted HTTPS under Wine. Desktop package review has not been exercised on native Windows.
The Linux desktop from `2aff05439e` showed a same-size damaged panel separately from panels outside the
Overlay limit. The running fixture Overlay filled the vacated slot with a usable panel. A damaged download
left the saved content in place. A CLI repair then refreshed the desktop and restored the exact panel to
the same running session. The desktop also repaired a missing panel. The Windows console host from that
candidate under Wine restored the installed release and kept its order and disabled state. Native Windows
desktop repair and WebView2 rendering of the recovered panel remain unverified.
In Linux Electron, a Modrinth API fixture rate limited the Mods tab. An early desktop retry and a Packs query
through the Host CLI preserved the same request count. After expiry, the desktop distinguished an HTTP 503
from the rate limit and displayed results after the next retry. A CLI mod repair left the installed file in
place during a CDN outage and repaired it when downloads resumed. A separate live search returned FerriteCore
for Fabric on 1.21.1. This response handling has not been exercised on native Windows.
The Linux desktop cancelled a reviewed Modrinth version change after staging its dependency and reading part
of the replacement JAR. The previous JAR and installed records stayed intact, staging was cleaned, and the
same review installed the exact replacement on retry. It also cancelled and retried a REZICS extension.
Closing Launcher waited for an in-flight download to cancel and removed its staging folder before exit. A
separate Linux Host CLI run interrupted staging with Ctrl+C and kept the installed ledger byte for byte.
These cancellation flows have not been exercised on native Windows.
The Linux desktop showed the replacement as the second of two reviewed mods and its received bytes
advancing from 5 to 12 while the stream was open. A REZICS extension showed its own received and published
sizes. The exact-release retry reported verification and publication, while a digest failure stopped at
verification and preserved the old file. Native Windows download progress has not been exercised.
The Linux desktop moved the ninth installed panel into the running fixture Overlay with the keyboard and
kept focus on the move button. A headless reorder refreshed the desktop and the same running session without
downloading artifacts or enabling a disabled panel. Reopening the profile kept the new order. The CLI refused
duplicate IDs and an outdated order. Reordering has not been exercised in the native Windows WebView2 panel.
With a fixture sidecar that paused reading its pipe, the standalone Linux Host and Linux Electron each applied
79 extension order changes and delivered the final eight panels to the same game session. The fixture received
19 update frames from the standalone Host and 13 from Electron. The previous Host sent all 79. Native
Windows sidecar backpressure remains unverified.
A windowless host fixture selected releases through the CLI, reported progress, rejected a stale cancellation,
cancelled the active attempt and retried as repair. After test device authorization and entitlement verification,
the same host launched a Java process and returned filtered diagnostics. Linux Electron showed the CLI's
device code, shared cancellation, and reflected the signed-in profile and its selection. These fixtures
used synthetic provider responses and game files.
In the Linux desktop, starting an unprepared Minecraft instance through the CLI updated its open Logs tab
without a game session. Open installation focused the preparation controls. A failure on that instance did
not change the local game's Logs tab. The local fixture then exited with code 7 and the same tab showed the
last output from its descendant process with the authorization value removed. This refresh has not been
exercised on native Windows.
In Linux Electron, the CLI started a Java fixture that wrote a new Minecraft crash report and returned
exit code zero. The open Logs tab showed its heap diagnosis and opened Settings. The CLI kept the exit
code and reported a truncated excerpt. Its filtered log matched Copy diagnostics, including the excerpt
and process output with the fixture's credential and local path removed. These checks covered light and
dark desktop layouts. A clean relaunch omitted the previous crash. Core fixtures rejected linked files,
invalid report contents and reports from a user-stopped attempt. Crash report capture has not been run
on native Windows.
An HTTP fixture with synthetic credentials exercised the host's real Kernel client for both shelf kinds. It kept multiple
local installs per Subject, preserved the next cursor on an empty filtered page, and reported expired
credentials, denial and stale cursors. The fixture also checked that requests carry no local paths or local
Subject filter and that a second reader receives no previous session header. Live device authorization and
authenticated desktop shelf rendering have not been exercised.
An open Linux Electron profile and, separately, a Windows console host under Wine supplied local installations
for an authorized command-line Library read against an HTTP fixture. The Linux run preserved multiple local
matches and an empty filtered page's continuation. An exclusive profile without an automation endpoint returned
`installations-unavailable`. The fixture could still read a remote page with zero entries without touching that
profile.
The mounted Kernel HTTP route and a migrated PostgreSQL fixture verified both game shelf kinds with signed test
credentials. Kernel refused a credential without `progress_session:list`. The full view returned
`semantic_not_ready` while the basic view returned the typed entries. Launcher retried the same query, marked
metadata unavailable and joined the recognized installation from a running host. The Windows console executable
exercised the same recovery with an HTTP fixture under Wine.
The Windows installer's application archive ran in Linux Electron. Launcher opened on REZICS online and
passed the configured Web Library URL to the system browser port. The Installed filter showed both a
Subject-linked game and an unlinked game added through the running Host. The search and matched game's
keyboard focus survived a trip into its detail page. Switching to REZICS online and back kept the search,
and clearing a search with no matches returned focus to the search input. The run covered compact dark
and desktop-width light layouts. It used a fixture Web origin.

A fixture executable exercises import, launch, session, game exit and backup. The native Overlay accepts the
same session shape and independently exercises window placement and input over a controlled window. Verify
that one instance's backup or update cannot alter another, an untrusted artifact cannot become an installed
package, and an interrupted operation recovers the previous state. Exercise catalog lookup, authorized
publication, install, update and withdrawal with fixture artifacts. Record real-game qualification, including
Microsoft sign-in and the Ren'Py journey, against the [desktop Goal](goals/launcher.md).

Two earlier Linux packages exposed the same 95 named commands and five subscriptions.
The newer of those packages dispatched all four bundled plugins through their declared main entries. The official Ren'Py
sample kept its Subject and local save, and clearing, editing, leaving or reloading the picker closed the outstanding
lookup. Inspection required the native executable selection. Game Footprints exported using the chosen save path,
and Diagnostics copied the bounded report to the clipboard. A real Mercury Forge pack retained its preview after
rejecting Java 21, imported with Java 17 and copied only the selected world. Forge preparation then completed and
Play reached account selection.

The Game Footprints plugin in the packaged Launcher retained its previous settings and exported an existing
record with a newly completed Subject-linked run. Export immediately after exit included the completed run.
A run started before opt-in produced no local record. A blocked footprint directory surfaced an error in
Library while the game still reported its normal exit. This passed in the compact dark and desktop-width
light layouts on Linux.
The Host CLI exposed the four bundled plugins' declared commands in versioned JSON and terminal help
without opening a profile. The packaged Linux desktop reflected CLI opt-in and opt-out while open,
and the desktop and CLI exports contained identical bytes for a completed Subject-linked fixture. The
Windows installer's application archive repeated the same desktop and Host checks in Linux Electron.
The packaged Windows console host under Wine listed the same plugin owners, recorded and exported a
completed game fixture, and preserved the existing export on a repeated request.

Packaged Linux runs left the game active when the player declined quit or cancelled it from the tray.
Scheduling quit again with the window hidden kept the same process and persisted its terminal log and
automatic backup before Launcher exited. A separate quit requested just after game exit waited for the
same files while a descendant held the game's output pipe. The saved log kept the final line and marked
the bounded output as truncated.

The Linux terminal host kept the same game and Overlay session reachable during a `quit-host` request
and when a termination signal was delivered to the Host process. The CLI rejected a new launch and a
stale stop request, stopped the selected game, and reopened its final log and backup from the released
profile. A controlled sidecar held its retirement open and the profile stayed locked until the sidecar
closed. A separate preparation accepted before the quit request was still visible and cancellable by its
attempt ID after it acquired the instance lock.
The matching Windows x64 installer included the same console Host. Under Wine, its `quit-host` kept the
selected game queryable and stoppable, persisted its log and automatic backup, and reopened the profile.
The terminal quit flow has not been run on native Windows.

The packaged Launcher reported a failed automatic backup after a fixture exited with code 17. The same
game launched again with the snapshot folder still obstructed. After the folder was restored, a manual
checkpoint preserved the automatic failure. Retrying the automatic backup cleared it, and restoring that
backup recovered the fixture bytes and created a pre-restore snapshot.

The packaged Linux Launcher reused a pinned automatic snapshot across repeated game exits, a full Launcher
restart and retry after an obstructed snapshot folder. A named manual backup stayed in history. A same-size
save edit produced a new checkpoint, and damage to that checkpoint caused the next automatic run to create a
verified copy without removing the damaged record. The original checkpoint still restored and made a recovery
snapshot. The history and retry results were checked in compact dark and desktop-width light layouts.

The packaged Launcher also reopened with a fixture representing an interrupted restore. It kept an
independently replaced save directory and the original rollback copy, then linked the launch diagnostic
to Save history. Once the interrupted restore's staged directory was returned, retry restored the
original checkpoint before starting the fixture game, which read the original bytes.

The standalone Linux Host imported The Question 7.0 with a separate save-folder fixture. At the publication
syscall for restore and again for rollback, a new empty destination kept its inode. The saved checkpoint,
the latest player save and the journal stayed available. After the destination was freed, retry recovered
the player save, then restored and exported the reviewed checkpoint. The Windows x64 Host under Wine
returned a partially applied save to staging, recovered the original and round-tripped a portable snapshot.
Built Linux Electron checked damaged and intact Minecraft backups through Save history. Native Windows
restore publication and recovery remain unverified.

In a visual novel fixture with 104 snapshot folders, the standalone Linux Host and Windows x64 Host under
Wine returned 100 readable records. They identified truncated JSON, a missing manifest, a mismatched ID and
an invalid timestamp individually. The read left the unresolved restore journal and the live save in place.
After the fixture cleared the journal, the Host restored the reviewed checkpoint. Built Linux Electron let
the player expand a damaged record by keyboard in the compact dark layout and restore the intact backup in
the desktop-width light layout. Native Windows desktop history has yet to be verified.

The packaged Electron application used an HTTPS catalogue fixture to install and update a declarative panel.
A changed artifact with the published size and a different digest was rejected. The running session kept its
existing panel until retry succeeded. Disabling, re-enabling and uninstalling then updated the same session.

The packaged Launcher installed nine panels from an isolated HTTPS catalogue. The active session sent all
eight displayed panels in a frame above 16 KiB. Extensions marked the ninth and promoted it into the same
session when the first was disabled. An older sidecar received the fitting panels within 16 KiB. The production
Rust decoder accepted the captured current-sidecar frames, including a panel with repaired Unicode text. The
bundled React view rendered all eight from each frame and preserved keyboard focus across the update in both themes.

The packaged Linux Launcher started a fixture game and attached a controlled Overlay sidecar while an HTTPS
extension download was held open. The first frame contained the previously installed panel. Completing the
download sent the new panel with the same session ID and game PID. Further launches used the built-in destinations
with a malformed ledger and displayed the valid panel when a sibling record was malformed. A core test also
committed an edit during the startup ledger read and verified that the first published session included that edit.

The packaged Launcher also used the real Kernel HTTP routes against a migrated, isolated PostgreSQL database.
The Kernel denied anonymous and unauthorized publication and replayed an authorized publish idempotently.
The Launcher installed the published panel, refused a same-size artifact with a different digest and updated
the running session after a successful retry. When the curator withdrew both releases, the panel disappeared
from discovery and fresh installation failed. The existing session kept its installed panel. Native route
tests also covered conflicting idempotency payloads, unauthorized withdrawal, withdrawn dependencies and
pagination. [Native catalogue tests](../services/kernel/test/launcher/distribution.test.ts)

The windowless Linux Host used the mounted Kernel catalogue on migrated PostgreSQL to install and
switch between two reviewed Fabric release pairs. Each pair contained the official Fabric API JAR
for Minecraft 1.21.1 and an exact dependent fixture mod.
A same-size update with the wrong digest left both installed JARs and the local save intact.
A valid retry updated both releases, and selecting the earlier pair restored the original bytes.
The Host rejected a stale review and repair when the catalogue withdrew the required release.
The built Linux Mods page used a replay of the catalogue to show the exact withdrawn release on the repair row
and kept the dependent mod in the installed list. A licensed Minecraft world launch with these
curated releases remains open.
[Fabric API 0.116.1](https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.116.1%2B1.21.1/) ·
[Fabric API 0.116.2](https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.116.2%2B1.21.1/)

The packaged Launcher kept two Minecraft preparations visible from Extensions and after reloading its
window. Cancelling the queued preparation left the active download running. Cancelling and retrying that
download completed installation and enabled Play for its instance. The check used a compact dark window
and a desktop-width light window.

While a controlled Java game was running in the packaged Linux Launcher, an install and a repair for
other instances entered the preparation queue. Cancelling the install left the same session and repair
active. Reloading Launcher kept the repair visible and the damaged client stayed untouched until the game
exited normally. The original repair attempt then restored the official Vanilla 26.3 client digest, and
the Java fixture's final save appeared in its automatic backup history.

The packaged Launcher prepared official Vanilla 1.21.1 on Linux. An obstructed asset directory reported an
asset failure and offered retry. The progress count covered 3,890 distinct assets and remained visible after
a window reload. Cancelling after a completed batch and retrying preserved the client JAR and the digests
and modification times of the sampled cached assets. The final verification enabled Play. Both layouts
displayed the shared progress bar.

The packaged Electron archive ran with Microsoft, Xbox and Minecraft fixture responses on Linux.
The account panel recovered the same device code after a window reload. Approval while the player was
on the Settings tab updated its account selector automatically. A denial remained visible after leaving
the page. Cancelling stopped the pending polls and the next reconnect kept the existing profile. These
checks passed at compact dark and desktop-width light sizes.

In a Linux network namespace with only loopback, packaged Launcher reused a cached entitlement-checked
fixture profile after two complete desktop restarts. It started a Java fixture through the Minecraft launch
path with 5,149 indexed assets, made no provider requests after sign-in, and backed up the fixture's world
after each exit. Corrupting an asset without changing its size stopped Play before the game process started
and opened installation repair from the launch log. Restoring the valid asset allowed an offline launch and
preserved the earlier world bytes and backups.
The account provider and protected storage used isolated test fixtures.

The packaged Launcher used a controlled Overlay process and a running local fixture game on Linux. The
shortcut remained hidden on registration failure after a renderer reload. Two consecutive crashes reached
the retry control, and restarting a ready Overlay retired the previous child before sending the same session
to its replacement. The game PID stayed live. Both themes passed. Under Wine, the cross-built Win32 host
reported a shortcut reserved by another Win32 process. After release, it passed registration and reached
WebView2 initialization. The Wine environment had no working WebView2 runtime.

The NSIS-installed Overlay from `1707758584c` reported `webview2-unavailable` before Microsoft WebView2 was
available in its Wine prefix. With Microsoft's official x64 Fixed Version 158.0.4370.33 supplied in the
same prefix, the browser started and wrote a crash dump before Overlay sent a ready frame. Using a separate
browser data directory did not reach ready. In the installed Host's game path, startup failure left the
Win32 fixture playing with the same session ID and PID. The CLI retried and disabled Overlay,
re-enabled it with Ctrl+Shift+F9, and stopped the game. Quitting released the profile and retained the
alternate shortcut. The live WebView2 panel and its focus and input behavior still require native Windows evidence.
[Microsoft WebView2 runtime distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

The installed Windows Host under Wine reported `webview2` with no runtime and `webview2-startup` when
the loader detected Microsoft's Fixed Version 158.0.4370.33 and initialization failed. The retry kept the
same Win32 fixture process in each case. Playwright in packaged Linux Electron exercised the two responses.
The unavailable state opened the official download on request. The detected state kept Retry Overlay
across a window reload, and a ready reply restored the controls for the same game. The diagnostic
and action layouts were checked at compact dark and desktop light sizes.
[WebView2 loader version query](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl#getavailablecorewebview2browserversionstring)

The Windows-target tests ran under Wine and distinguished a browser or main-renderer exit from failures
that WebView2 can recover. The rebuilt Windows installer contained the matching sidecar and loader.
In Linux Electron, its application archive reattached a controlled sidecar once after an exit, exposed
manual retry after a second exit, and bound every replacement to the same live game. The packaged native
fixture now stops the browser in its isolated Overlay profile and checks focus, click delivery, and
replacement. This WebView2 crash and recovery has not been exercised on native Windows.

The standalone Linux Host, Linux Electron and Windows x64 Host under Wine replaced an exited fixture
sidecar while a descendant still held its pipes. Each kept the game PID and session, reported the
fixture's WebView2 startup failure, accepted a manual restart and released the profile with all four
fixture descendants alive. Native WebView2 pipe inheritance and shutdown have yet to be checked.

The packaged Launcher also kept the shortcut hidden after the WebView ready frame, after an attachment reply
for a different session and across a renderer reload. An attachment rejection offered Retry Overlay. A successful
retry restored the shortcut for the same running game in compact dark and desktop-width light layouts.

Under Wine, the packaged Overlay with its loader reported a hotkey conflict while another Win32 process
held the shortcut. After release, the same binary reported a separate typed WebView2 startup failure.
The packaged Linux Launcher exercised that frame with a controlled sidecar. The failure persisted across a
window reload, and the download button opened only the fixed Microsoft page when activated. A manual retry
after the fixture became available restored the shortcut on the same game process. The compact dark and
desktop-width light layouts wrapped the recovery controls within the sidebar.

The packaged Launcher selected F10 when the default and F9 were reserved by its sidecar fixture, kept the
same game process, and selected F10 again after a full Launcher restart. Switching back to the default
reused the running game. A preference write failure left the previous shortcut and sidecar state in place.
Under Wine, the packaged Win32 binary independently reported a conflict for the reserved default and F9,
and each available alternate reached WebView2 initialization. The bundled HUD displayed the selected preset
from its native view event in a browser fixture.
The Windows qualification runner reserves the default shortcut in its controlled fixture, requires the packaged
Launcher to report the conflict, and opens Overlay with the saved alternate on the same game. It releases the
reservation and verifies the original shortcut again. The evidence gate requires this observation for the candidate.
The Win32 fixture reserved and released the default when its pipe closed under Wine. PowerShell checks verified
alternate key dispatch, window restoration after a failed selection, and rejection of a report without the observation.

Linux desktop qualification used The Question 7.0 from the official Ren'Py 8.5.3 SDK. The installed sample
exercised readable metadata, compiled engine detection and an unknown working folder. Through the packaged
application archive on Linux, a player launched the game, wrote two save slots, restored the selected save
root and loaded the restored slot in the game. The other root kept its newer slot. A separate run exercised
the real Linux file and folder choosers. The reference source is pinned in the [clone index](../.reference/INDEX.md).
[Ren'Py 8.5.3 release](https://www.renpy.org/release/8.5.3)

The NSIS-installed Windows x64 Host under Wine discovered The Question 7.0 built for Windows from the
same SDK and 99 fixture installations. Piped JSON through a Windows command pipe imported the reviewed
batch and returned the same 100 instance IDs on replay. The Host read The Question's title and version,
queried a local catalogue fixture on request, and kept the confirmed Subject association.
The Windows game wrote real save slots to AppData and its game-local folder. The Host backed up both
roots on exit. A reviewed restore recovered the damaged slot in AppData byte for byte and kept the
newer game-local slot. With the matching local copy moved outside the save folder, the game loaded the
restored slot and displayed the same scene. The original instance ID and Subject association survived.
Native Windows and live REZICS CLI or MCP interoperability remain unverified by this run.

In a separate copy of the Linux release, the packaged Launcher read The Question's title and version from
the original build manifest after the game's `.rpy` sources were removed. The title and version appeared
in Import and Overview. Searching the detected title sent one filtered lookup to a local HTTP fixture
after the player requested it. The selected Subject and explicit save folder survived reload. The game
opened its native window and the Launcher created a local save snapshot on exit.

The packaged Linux Launcher also started The Question with two ancestor folders named `Ren'Py Data`. The
previous package omitted the profile in the nearer folder from its automatic backup. The update previewed
that path before launch and backed up the slot written there by the game. A second run inherited
`RENPY_PATH_TO_SAVES` while both ancestor folders existed and used the override for preview and backup.
In both runs the player linked the detected title through a catalogue fixture and restored only the
external profile. The restored slot matched the original bytes and the newer game-local slot was preserved.

Two more packaged Linux runs moved The Question's content into an executable-named folder and into `data`.
The old package used a decoy title and save folder in the conventional layout. The update read the actual
title and game save folder in both layouts, even when the player selected a separate working folder. The
player linked the detected title through the catalogue fixture and restored the original game-local slot.
The newer external slot and the decoy files were preserved. Core coverage also restores the same game-local
backup after the content folder changes and rejects a preview of the earlier folder.

The official KiriKiri Z 1.4.0r2 runtime wrote saves for a loose KAG test project under Wine, using the
game-local path configured in the executable's `.cf` file. The packaged Launcher on Linux detected the
project's Japanese title and save directory, requested the title from a catalogue fixture after explicit
search, and stored the selected Subject. The player backed up the saves and restored the original bytes
after removing the save directory. Core tests also cover legacy CP932 titles, standard XP3 headers and
the earlier `game/saves` snapshot root.
[KiriKiri Z 1.4.0r2 release](https://github.com/krkrz/krkrz/releases/tag/1.4.0r2)

The same runtime under Wine loaded a KAG test project from an XP3 appended to the Windows executable
and wrote two save files. The compiled Linux Host discovered and registered 100 copies of that packed
layout without a window. A repeated import kept the same installations. The Host read the Japanese
title and game-local save folder, then restored both engine-written files byte for byte. Core coverage
also checks standalone XP3 archives, a companion archive and fallback when packed metadata is protected
or malformed. Native Windows testing of the packed layout remains open.

The packaged Linux Launcher opened a portable backup with two save folders from the KAG test installation.
The player restored the KiriKiri files to a chosen folder and left the second folder in the backup.
Replacing the chosen folder at the same path invalidated the preview. After another review, the restore
copied the original save bytes and put the displaced files in a recovery checkpoint. The player restored
that checkpoint to a directory discovered from the executable's `.cf` file. Editing the `.cf` after preview
required another review. The source backup and the receiving installation's other saves kept their bytes.
A separate packaged run prompted before restoring a newer Minecraft world to an older instance and preserved
the other world in that instance.

The packaged Launcher also recovered the same The Question installation after its folder was moved. The player
opened Settings from the failed launch report, used the picker for the replacement executable and saw the
Ren'Py version in Overview. REZICS search used a fixture response and the selected Subject opened its canonical URL.
The instance ID and save history survived the move. The sample relaunched and loaded a save made before the move.

With a separate local Kernel and its PostgreSQL and OpenSearch services, the packaged Launcher exercised a real
`index_not_ready` search response and the picker retry. The player entered the canonical Subject ID, saved the link
and reopened Settings. The displayed title came from the native public Subject read. An injected read outage
still allowed local settings to be saved. Retrying restored the title with the same Subject ID and local save.
The outgoing requests carried the search title, languages, type filter and limit or the canonical Subject ID.
The successful search result and same-title exclusion passed with recorded responses.

The packaged Launcher detected The Question's local Ren'Py title and sent no title search during inspection.
Activating Search detected title with the keyboard sent one filtered lookup and focused the shared picker.
Typing the same title also worked. Selecting the result, reopening settings and retrying a catalogue outage
retained the Subject ID and the local save. Clearing the saved link and reopening Settings let the player use
the detected title again and save the same Subject. These checks used a recorded catalogue response.
The packaged Launcher also kept the canonical link and local save when the player cleared a different search
title and saved a local name change. Explicit removal and relinking worked in the same journey.

With The Question and a local HTTP fixture, clearing the query, replacing it, leaving Settings and reloading
the window each closed the outstanding request at the server. The packaged client accepted the next result
and kept the existing Subject ID and local save in both themes.

With an isolated Kernel backed by PostgreSQL and OpenSearch, the packaged Launcher imported the same Ren’Py
installation using a pasted REZICS Subject link while title search returned HTTP 503. The exact public
read supplied the title for explicit selection. Pasting the same-title book link left the selected VN
unchanged. In Settings, choosing a second VN by its ID and saving persisted the new link and preserved the
local save. The requests reached Kernel with only the exact Subject IDs and no query parameters.

Clean Kernel stacks returned `503 index_not_ready` for both text-only and type-filtered search, while native
public reads by Subject ID succeeded. The repository Search driver reconciled all 4,096 homes and adopted
sealed Source coverage. During activation the prepared result was exhausted and no home had acknowledged
that baseline yet. The publication job did not acquire its fence or publish an active Subject generation
within the 12-minute observation. The public API probe from this host also ended during TLS setup, before
the server returned an HTTP response.

With a catalogue fixture, a packaged Linux Launcher using the `zh-CN` desktop locale displayed a
Traditional Chinese title when the Subject offered English and Traditional Chinese translations. The picker and
the saved link showed the same title. During a simulated catalogue outage, the local name remained editable
and the existing save remained readable.

The packaged Launcher exercised both kinds in the shared import form. The Visual novel contribution detected
The Question 7.0, restored the draft Ren’Py save name after changing the kind, and used the selected save folder
when both were supplied. Its shared Subject picker saved and reopened a localized fixture result. Another visual
novel supplied its save name manually when engine metadata was unavailable. Other local game imported
independently with only the common fields.

The Windows x64 NSIS candidate built on Linux. The installer payload matched the unpacked Launcher,
application archive, Overlay and WebView2 Loader byte for byte. The Overlay and a Win32 fixture also
cross-built on Linux. A Wine run exercised pointer input
in the mapped fixture window, kept the packaged Launcher window unmapped, and stopped at Overlay WebView2
initialization. Native layout, hotkey, focus and input
qualification requires the packaged app on Windows x64 with WebView2. Minecraft Windows qualification also
requires the approved Microsoft public client and a licensed Java account.
[Windows qualification runner](../apps/overlay/README.md#standalone-window-fixture) ·
[Packaged Launcher and account lanes](../apps/launcher/README.md#windows-release-qualification)

The packager from `807efeb0727` refused a fresh GNU x64 Overlay with its loader missing and with the upstream
x86 DLL in its place. With the x64 DLL, the NSIS archive contained the matching desktop executable, app
archive, console Host, Overlay and loader. Under Wine, that Host moved the ninth panel into the current
session, skipped a missing VN save folder, and backed up and restored the first save. The Overlay reported
the unavailable WebView2 runtime while the game stayed running. The candidate's evidence check reported the
approved Microsoft application ID and native fixture and licensed runs as outstanding. The static-loader
branch was checked with a PE fixture. An MSVC package and native Windows WebView2 remain unverified.
The normal Overlay build from `c155f90be58` cross-built GNU x64 into a target directory with spaces and staged
the exact loader reported by Cargo. A cached build restored an absent DLL and replaced a stale copy without
rebuilding the executable. The Linux host build produced no loader and all ten Rust tests passed. The fresh
NSIS candidate contained the pair directly from the Overlay build. The packaged Host replay passed under Wine.
The native Windows build path and the licensed Minecraft runs remain unverified.

The earlier NSIS setup reported Launcher running in an empty Wine prefix. Wine's PowerShell stub returned
success without running the probe command. The updated setup uses CIM when PowerShell returns the expected
output. The fallback finds the desktop and terminal Host by their complete executable names and asks the
user to close them. A silent run cancels while either process is active. Under Wine, setup installed
beside a similarly named fixture and the installed console Host answered commands with its packaged
resources. Setup refused to replace the package while the exact desktop fixture or the serving Host was
open. The serving Host accepted commands and quit normally. Retrying setup preserved its profile.
Native Windows setup and WebView2 remain unverified.
[electron-builder process check](https://github.com/electron-userland/electron-builder/blob/e2a8604535bdc626bd068ddf5b6afb67bed45725/packages/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh)

Using the Windows candidate's application archive in a packaged Linux Electron process, the sign-in request
used the packaged client ID with and without a conflicting environment value. Missing and blank client files
reported configuration before any request. The test intercepted the device endpoint locally. The evidence parser
rejected synthetic passing reports for an unconfigured candidate and for a changed client file.

Under Wine, the Win32 placement and visibility routines kept a pinned HUD hidden over another window of the
same process. An injected key sequence produced the registered Win32 hotkey message over that sibling window.
The native target check kept the HUD suspended and left the sibling in the foreground. The hotkey check discarded
the saved foreground handle after focus changed, and a fresh hotkey on the original game window was
admitted. The HUD returned at the moved game bounds and after the game was restored from minimize. The
game kept foreground focus and won the pointer hit test in both cases. The interactive state stayed closed
after focus loss. These checks used native windows without a WebView. The Windows fixture includes the sibling
window check with WebView2 and records it alongside pointer delivery to the game.

The cross-built Win32 probe received top-level deactivation under Wine after a child control held keyboard
focus. It hid the Overlay and the new foreground window retained focus. A bundled renderer check replaced an
opening without rendering an intermediate hidden view. Both themes moved focus back to the title, preserved focus
within live panel updates, and sent the new opening ID with Escape, Return to game, pin and destination commands.

Under Wine, the Win32 probe rejected the fixture's actual MessageBox as an Overlay target while it owned
foreground and its game window was disabled. Dismissing it restored the game window and its shortcut target.
The probe also checked a borderless game, an enabled owner of a modeless window, and the pinned HUD state
before and after the modal prompt. These checks exercised native window selection and visibility without
WebView2. The Windows qualification report now requires the real WebView2 journey in hidden and pinned modes.

At 100% and 150% scale under Wine, an ordinary game window and a mirrored, DPI-unaware sibling each moved
and resized while the cross-built Win32 probe followed the client bounds. The registered hotkey and keyboard
input reached the probe. With the game in the foreground, both fixture windows received pointer clicks through
the pinned window. The probe restored game foreground through the fixture to check click-through. Automatic
focus return through WebView2 and a move between displays at different scales have separate native fixture checks.

Under Wine, the Win32 fixture switched the foreground game from windowed to topmost borderless mode at the
same client bounds. The previous placement routine left the HUD behind the game. At 100% and 150% scale,
the updated routine kept the HUD above the game through both mode changes and left the game in the foreground.
Hit testing still reached the game, and a separate topmost utility above the HUD kept its place. The native
WebView2 qualification requires a click through the borderless HUD and repinning from its interactive panel.

The packaged Linux Launcher restored five interrupted preparations to its activity sidebar after the
process stopped during an official Vanilla 26.3 asset check. Opening the interrupted install from Extensions
focused its retry controls, and the retry completed. Separate interruptions after the atomic instance write
left the saved install and repair ready on restart. The repair restored the official client digest after
a same-size corruption. The interrupted and ready views were checked in compact dark and desktop-width light layouts.

Linux Electron qualification installed official Minecraft 1.21.1 Vanilla resources and applied Fabric
0.16.14 to the same instance. The activity entry opened the version settings and focused its heading.
The existing world bytes matched and the backup was labelled with the previous Vanilla selection.
In a separate packaged run, a same-size change to the official Vanilla client produced an
installation failure. The player opened repair from the launch log and restored the original Mojang digest
with the world intact. The next attempt reached the account screen.

A clean packaged Linux run downloaded Minecraft Java 26.3 Vanilla, the stable release listed by Mojang on
2026-11-21. A fresh profile using the candidate archive selected the labelled latest release and pinned 26.3.
Using the populated resource cache, the candidate verified the metadata, client, asset index and 5,149 unique
assets against their published hashes. Mojang's managed Java reported version 25.0.5.1. Removing its executable
sent Play to installation repair. Repair restored the Java executable byte for byte, reused the verified
client and a checked asset, and kept the existing world fixture. The next Play attempt reached the Minecraft
accounts section. [Minecraft Java Edition 26.3](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)

With the other official Vanilla 26.3 files cached, the Linux package installed a new instance without
JSpecify cached. The previous package failed while both Mojang's library endpoint and `repo1.maven.org`
were blocked by the fixture. The update downloaded the JAR from `repo.maven.apache.org` and matched
Mojang's published SHA-1. After a same-size change to the JAR, Play opened installation repair. With
Mojang and `repo.maven.apache.org` blocked, repair retrieved the same bytes from `repo1.maven.org`, kept
the world marker and allowed Play to reach account selection again. The same package prepared Forge 66.1.9
and NeoForge 26.3.0.115 for Minecraft 26.3, repaired their generated library records and reached account
selection with the worlds preserved.

The same official Vanilla 26.3 cache qualified same-size corruption in an indexed asset and in the managed
Java runtime's `lib/jrt-fs.jar`. Java still reported its version with the damaged JAR. Play opened installation
repair for both failures before account selection. Repair restored the published digests, kept the existing
world and reused the sampled valid client, asset and Java executable. With a healthy cache, the new checks
reached the account prompt in around 1.3 seconds on the Linux test host, compared with 0.4 seconds before them.

The Windows x64 Host installed by the NSIS candidate from `1707758584c` selected Vanilla 26.3 from
Mojang's live catalogue on 2026-11-22. From an empty profile under Wine, it downloaded the client and
managed Java 25 x64. Cancelling at 32 of 5,149 asset objects left the instance unprepared. After the
Host restarted, retry completed the same instance and reused the verified client JAR. During separate
launch attempts, a same-size change to an indexed asset and one to Java's `lib/jrt-fs.jar` each directed
the caller to installation repair. Repair restored the published digests. A selected-world backup
then restored the changed region file and checkpoint without changing the sibling world. Two cold
Host sessions reached account selection. Native Windows licensed sign-in and world entry remain
unverified for this candidate.
[Minecraft Java Edition 26.3](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)

The previous Linux package prepared Mojang's Java 25 for Vanilla 26.3, but `ProcessBuilder` returned a
permission error because `lib/jspawnhelper` lacked executable permission. Opening the same installed instance
with the updated package and pressing Play restored 32 executable files and 205 published links from the
verified cache. The JVM created a child process and read its exit status. After damage to a runtime JAR and a
link, Verify and repair restored both and kept the existing world. Play then reached account selection.
The Windows x64 package's Node runtime under Wine verified all 411 regular files in the official Windows Java
25 manifest and ran the same Java child-process fixture.

The Host CLI rejected Java 17 for a new Minecraft 1.21.1 instance and kept its saved policy when release
metadata was unavailable. After installation, it checked the selected Java against the stored requirement
with release metadata unavailable. Linux Settings checked an official managed Java 25 runtime in a prepared
fixture profile, reported same-size runtime corruption, and rejected a Java 8 selection without changing the
policy. The Windows console host from `1e7d954928` checked the official Windows x64 Java 25 cache under Wine,
reported the same corruption as a repair issue, and resolved a compatible `javaw.exe` selection to
`java.exe`. The new Java check has not been exercised on native Windows.

The standalone Windows x64 Host from `fb0ace48ab4` prepared official Minecraft 1.21.1 under Wine from
an empty profile. The Host was killed after it recorded progress on 32 of 3,890 asset objects. The next
Host reported the interrupted attempt and found no committed installation. Repair completed the same
instance and reused the client JAR, which matched Mojang's published SHA-1. Launch diagnosed a
same-size change to the client JAR. After another same-size change to the managed Java executable,
repair restored both files to their original digests. Fabric Loader 0.16.14 prepared in a separate
instance and reused the verified client and Java files. The Host probed Java 21 x64 successfully and both
instances reached account selection through the console. Licensed sign-in, world entry and native Windows
remain unverified for this run.

The packaged Linux Launcher prepared official Vanilla 1.6.4 with Mojang's Java 8 and checked all 1,120
named assets. The previous package reported a successful repair with a damaged named icon still in place.
The updated package replaced a legacy hard link, then restored a changed icon and a missing icon from the
verified cache before reaching account selection. The world marker and an unrelated local file were preserved.
Vanilla 26.3 also reached account selection after verification. The Windows x64 package's Node runtime
under Wine exercised the same hard link replacement and changed or missing file recovery with a fixture.

On Linux, an ordinary file occupied the old native extraction path. The baseline packaged Launcher
remained in launch preparation and never started Java. The updated package started a Java fixture twice
with only a loopback network, using recorded account responses and all eleven Linux x64 native archives
from Mojang's Minecraft 26.3 profile. It extracted twelve files per launch. Java loaded LWJGL, wrote a
world marker and exited successfully each time. Each launch used a different native directory and
removed it after exit. Archive checksums, old path contents and the previous save marker were preserved.

On the packaged Linux Launcher, Vanilla 26.3 and Fabric 0.20.1 shared a verified copy of the game descriptor.
Changing the installer's cached descriptor left both prepared instances able to reach account selection.
A same-size change to the pinned Fabric descriptor routed Fabric to repair while Vanilla could still proceed.
A same-size change to the shared descriptor routed Vanilla to repair as well. Repair restored both pinned
copies and the Mojang descriptor, kept the existing client digest and world bytes, and returned both
instances to account selection. Separate packaged runs restored the pinned Forge 66.1.9 and NeoForge 26.3.0.115
descriptors after the same change and reached account selection on Minecraft 26.3.

On packaged Fabric 0.20.1 for Minecraft 26.3, same-size changes left the ASM and Fabric Loader JARs
readable as ZIP files. Play identified each damaged library before account selection. Repair restored ASM
to the checksum in the Fabric profile and the Loader JAR to the checksum from Fabric's Maven repository.
The client digest and world bytes matched their earlier values, and Play reached account selection.
The real Fabric 0.16.14 profile for Minecraft 1.21.1 also produced all eight checksums, including
Intermediary from Maven.

The packaged Linux Electron route also prepared upgraded copies with official Minecraft 1.21.1 and Fabric
0.16.14. After a blocked assets directory caused preparation to fail, reopening the window and retrying retained
the selected world. The ready copy matched the XMCL sample's level and region bytes and omitted the session
lock. A second copy used the same verified resources and contained no worlds. Both originals kept their bytes.
The compact dark and desktop-width light layouts exercised the two world selection modes.

In the packaged Linux Launcher, switching from 26.3 to 1.21.1 refused an in-place change on an instance with
two XMCL sample worlds. The default downgrade copy prepared official Vanilla 1.21.1 with Java 21 and
contained no worlds. After explicit confirmation, a second independent copy contained only the selected
world, with matching level and region hashes and without the session lock. Both source worlds kept their
hashes. A worldless instance could apply the same downgrade in place. Previewing a Mercury Forge pack for
the older 1.20.1 release showed the same world warning and initially left both worlds unchecked.

From an empty Linux profile, the terminal host previewed a change from Vanilla 1.21.1 to a separate
Vanilla 1.20.1 instance. It downloaded and verified the official client, assets, libraries and managed
Java 17. The attempt reached Ready, published the selected world in the new instance, and preserved the
source world byte for byte. This run covered preparation and copying through the CLI. Microsoft account
authorization and entering a world on physical Windows remain part of the packaged qualification.
The packaged Windows console host opened the profile under Wine, reported the in-place blocker, listed the
selected world's recorded release and rejected changed choices and missing confirmation before starting work.

A separate packaged Linux run used two XMCL sample worlds in a Vanilla 1.20.1 instance, with one
sample's `level.dat` release label set to 26.3. Launcher blocked an in-place change to 1.21.1.
Escape returned focus to the copy action and cancelling left only the original instance in the library.
After confirmation, Launcher prepared official Vanilla 1.21.1 and published a copy containing only the
selected world, with matching level and region hashes.
Using the same fixture in a separate run, Launcher imported the Mercury Forge pack for 1.20.1 after showing
the world warning. Only the chosen world appeared in the Forge instance. Both original world hashes and the
source instance record matched their previous values. Core tests also changed the recorded release during
preparation and verified that an earlier approval could no longer publish either kind of copy.

The packaged Electron archive installed official Minecraft 1.21.1 and Fabric 0.16.14 on Linux, then installed
Fabric API 0.116.1+1.21.1 from Modrinth. After a same-size change to its managed JAR, Play linked to Mods and
the repair restored the original published SHA-512. The installed record, world and independent file matched
their previous bytes or values. The next launch attempt reached account selection.
[Fabric API release metadata](https://api.modrinth.com/v2/version/vtBTVr1F)

The packaged Mods browser previewed Continuity 3.0.0+1.21 and its Fabric API dependency on Minecraft 1.21.1.
Cancelling left the instance untouched and returned focus to the release. Installing Fabric API during an open
review made that review stale. Refreshing showed only the remaining Continuity install, and both installed
JARs matched their published digests. Selecting the older Continuity release showed the installed and replacement
versions before any change. The interface passed in the compact dark and desktop-width light layouts.
[Continuity release](https://modrinth.com/mod/continuity/version/kSPJ4hQv)

The serving Host CLI installed Continuity 3.0.0+1.21 and Fabric API 0.116.18+1.21.1 from Modrinth.
Their files matched the published SHA-512 digests. A reviewed disable changed both entries. Repair
replaced a same-size damaged Fabric API JAR and kept it disabled. A fixture refused a changed
provider digest before artifact download, and an open Linux desktop reflected CLI import, disable,
repair and removal of a local managed mod. [Continuity release](https://modrinth.com/mod/continuity/version/kSPJ4hQv) ·
[Fabric API release](https://api.modrinth.com/v2/version/5SwzqWUu)

The standalone Linux Host and Windows x64 Host under Wine refused to review or confirm Continuity
3.0.0+1.21 when its retained Fabric API 0.116.1+1.21.1 JAR had same-size damage. After exact repair,
the review installed only Continuity and both JARs matched the published digests. The unrelated local
JAR kept its existing bytes. A fixture damaged a retained transitive requirement during download and
the install left the staged change unpublished. Linux Electron showed the dependency error, repaired
Fabric API from Installed mods and retried the review with only Continuity. Native Windows desktop
review and licensed world entry for this pair remain unverified.
[Continuity release](https://modrinth.com/mod/continuity/version/kSPJ4hQv) ·
[Fabric API release](https://api.modrinth.com/v2/version/vtBTVr1F)

Packaged Linux Electron reviewed a three-mod dependency chain at compact dark and desktop light widths.
Cancelling preserved the files and returned focus to the mod. A separate toggle made an open review stale.
Refreshing the review allowed the group to be disabled, and after a window reload the final mod could be
enabled together with its requirements. JARs, an unmanaged file and a fixture world kept their bytes. Core
checks also refused an occupied destination and a damaged dependency before changing the group. The installed
Windows host exercised the same grouped changes under Wine. Native Windows Mods UI remains unverified.

The Linux Electron fixture followed a duplicate-mod process report from Logs to Mods. It showed the exact
managed and manual JAR names, identified a committed Modrinth pack file, and skipped metadata reads for a
linked archive. The open-folder action sent the instance path to the shell port. Rescanning after a manual file
rename cleared the repeated ID and showed the disabled file. Native Windows file-manager and loader checks
for this panel remain pending.
The Linux desktop disabled the conflicting manual JAR directly from the diagnostic and preserved an
occupied destination, the managed JAR and both pack file names. A CLI re-enable refreshed the open
panel. Core checks refused a stale scan and finished an interrupted change when both names linked
to the same file. Dark and light desktop layouts exercised both states.

The packaged application searched Modrinth, discarded a verified download after preview,
and installed the Forge and Fabric editions of Mercury Beta 1.0.0 in separate instances. Only the selected
fixture world appeared in the Fabric instance. Editing the copy left both Forge worlds and the original
pack intact. During an in-place update to the real Mercury Forge release, cancelling with mods in staging
kept the previous pack ledger, world and independent mod intact. Retrying the same verified preview applied
the update. The packaged Logs panel recorded a fixture process exit, filtered synthetic credentials and local
paths from the clipboard report, and focused the installation controls after a recognized pre-launch failure.
Windows world entry is a separate qualification step.
[Mercury Forge release](https://modrinth.com/modpack/mercury-performance/version/M4Ij32cv) ·
[Mercury Fabric release](https://modrinth.com/modpack/mercury-performance/version/hfSow7J1)

The serving Host CLI previewed, installed and exported the online Mercury Fabric 1.0.0 release. The
30 installed files matched their published SHA-512 digests, and repair restored a same-size damaged
download. A fixture interrupted a staged update from the CLI and retried the same preview. The update
preserved worlds, an independent mod and edited settings. The open Linux Packs panel reflected both
CLI installs and the separate instance with one selected world.
[Mercury Fabric release](https://modrinth.com/modpack/mercury-performance/version/hfSow7J1)

The packaged Linux Launcher imported Fabulously Optimized 6.5.0 and prepared Minecraft 1.21.1 with Fabric
0.19.3. A restart fixture left one replacement override published and an independent file with the same
bytes as a pending override. The previous package stopped Play at pack verification. The updated package
restored the original override, kept the installed release record and reached account selection on two cold
starts. Repair verified the installed files. The independent file, disabled mod and fixture world remained intact.
[Fabulously Optimized 6.5.0](https://modrinth.com/modpack/fabulously-optimized/version/6.5.0)

The Windows x64 console Host extracted from the NSIS candidate built from `be2d99bc9ed` installed the
same release directly from Modrinth under Wine. All 50 required downloads matched the published SHA-512
digests. The Host prepared Minecraft with Fabric 0.19.3 using its verified game resource cache and
routed a damaged JAR and missing nested override to pack repair. Repair restored both files and
preserved a player-edited configuration, a manual disabled file and both test worlds. The original
instance reached account selection again after the Host restarted. Export preserved the pack manifest
and original overrides. Re-importing that archive created a separate instance with only the selected
world and kept both source worlds intact.
NSIS setup reported Launcher running in the isolated Wine prefix and did not install.
The tested Host came from the verified installer payload. Native Windows setup and licensed gameplay remain pending.

The packaged Linux Launcher prepared official Forge 47.4.10 on Minecraft 1.20.1 with Eclipse Temurin 17,
and official NeoForge 21.1.206 on Minecraft 1.21.1 with managed Java 21. In each instance, a same-size change
to the generated client JAR opened installation repair from the launch log. Repair verified the generated
files, retained the instance and its saved world bytes, and the next Play attempt reached account selection.

The standalone Windows x64 Host under Wine prepared the same official Forge and NeoForge releases with
Mojang's managed Java 17 and 21 respectively. The previous Host failed with `EFAULT` while removing a
nested processor staging directory. Retrying both failed installations with the updated Host removed those
directories, kept an unrelated entry and verified all seven generated files for each loader. After a
same-size change to each generated client JAR and, separately, removal of its output checksum record,
launch reported installation repair. The Host restored the files and checksum records, kept the original
instances and world files, and returned to account selection. Licensed sign-in and world entry on
native Windows remain unverified.

The packaged Linux Launcher selected official Forge 66.1.9 and NeoForge 26.3.0.115 for Minecraft 26.3 from
their live catalogues and prepared both with Mojang's Java 25. A one-byte change to each generated client JAR
led from Play to the installation repair. Repair verified the generated files and kept the pinned release
and world bytes. A successful repair dismissed the installation alert and kept the previous report in Logs.
Play then opened account selection for each instance.
The same flow passed for Forge 52.1.21 on Minecraft 1.21.1 after selecting Eclipse Temurin 21.0.13.1+2.
Mojang's managed Java 21 on the Fedora test host failed Forge's published checksum for an intermediate JAR.

In the packaged Linux Launcher with the same official 26.3 releases, changing the preparation cache alone
left the installed output list usable. Changing the installed Forge list or removing the NeoForge list
opened Installation from the launch log. Verify and repair restored the complete list and its digest.
The selected releases and saved world bytes were preserved, and Play returned to account selection.
The desktop transport fixture also repaired a damaged NeoForge output without a published hash and added
the digest to an older installation record.

The packaged Linux Launcher changed a Minecraft 26.3 Forge 66.1.9 instance to NeoForge 26.3.0.115. While
a nested disabled JAR was present, the picker offered a separate copy. The copy contained the selected XMCL
world, with matching level and region bytes, and left the source world, sibling world and JAR intact. The host
refused an in-place change when the JAR was restored after the player opened confirmation. After a fresh
check with the JAR removed, in-place change kept the instance ID, both worlds and a backup marked with the
old Forge version. The picker also required a separate copy to downgrade the instance with worlds to 1.21.1.

The packaged Linux Launcher verified an official Minecraft 1.21.1 instance using Java 21, then prepared
Minecraft 26.3 as a separate copy using Java 25 selected in the desktop picker. A failed Java 21 attempt
retained the selected version, Java and world after a full Launcher restart. The retry reproduced the
compatibility error, and replacing Java prepared the copy with only the selected world. The original
instance record and both original worlds matched their previous bytes. An in-place change then applied
managed Java 25 with Minecraft 26.3 and kept a world backup labelled with the previous release. The
desktop bridge rejected a path that had not been chosen for the selected release.

The packaged Linux Launcher previewed Mercury Forge Beta 1.0.0 from Modrinth and rejected Java 21 for
its Minecraft 1.20.1 release before publishing an instance. Cancelling a controlled Java probe stopped
the probe and kept the same pack preview. Choosing Temurin 17 then installed the pack. A separate local
archive import copied only the selected world, retained its level and region bytes, and kept the original
worlds available. The imported instance prepared official Forge 47.2.17 and Play reached account selection.

On Linux, the packaged Electron archive installed Mercury Fabric Beta 1.0.0 from Modrinth and prepared its
official Minecraft 1.20.1 resources. Play detected a change to a required JAR of the same size and focused
the Packs tab from the launch report. Repair restored the published SHA-512 using the installed manifest.
The version, edited configuration, independent mod and world were preserved. A second verification kept
the same pack record, and Play reached account selection. The compact dark layout also verified that a successful
repair clears the pack failure from the instance banner, preserves the launch log and leaves account failures visible.
[Mercury Fabric release](https://modrinth.com/modpack/mercury-performance/version/hfSow7J1)

On Linux, the packaged Launcher previewed the XMCL sample world, preserved an existing world with the same
folder name, backed up the imported world and exported it to ZIP. The ZIP imported into a separate instance
with matching level and region bytes. Editing the copy left the source unchanged. These checks passed in the
compact dark and desktop-width light layouts.
[XMCL world fixture](https://github.com/Voxelum/minecraft-launcher-core-node/tree/154e2719b1ac962631d80ae4a280382f4f1ac09d/mock/saves/sample-map)

Both layouts also imported the XMCL sample directly from a folder. Launcher rejected a same-size change made
after preview and preserved an existing world with the same name. The copy retained the level and region bytes
and an empty directory, skipped the source lock, and round-tripped through backup and ZIP transfer. Editing the
new instance left both the first copy and the original world intact.

The windowless Host CLI exercised the same folder and ZIP transfer, including stale source and destination
reviews, explicit approval for a newer world, and a populated destination. The Windows console host under
Wine round-tripped the XMCL sample between two instances with matching level and region bytes. Its exported
ZIP omitted the runtime lock file, and editing the receiving copy left the earlier world and source intact.
The packaged Linux Saves panel added the CLI-imported world to its selection without a reload and then
imported the same fixture through the desktop picker.

The compiled Linux Host interrupted both folder and ZIP import after files reached staging. It interrupted
ZIP export while the archive was being written. Staged files were cleared, and retries succeeded with the
original level data. A built Linux Electron window cancelled an active copy by keyboard in dark and light
layouts, kept the preview and imported the same world on retry. It also cancelled an active ZIP export.
Under Wine, the exact Windows NSIS Host round-tripped the XMCL world and cleared a later folder import
when its automation client disconnected during copying. Native Windows desktop and Ctrl+C checks remain open.

Compiled Linux and Windows hosts preserved a source ZIP beside the staged world and handled a new name
conflict after files reached staging. A fresh preview suggested the next available name and imported the
original level data. The built Linux desktop accepted that suggestion through the world form and kept an
explicit conflicting name available for editing. The Windows binary under Wine also declined a direct
rename onto an existing empty directory. A syscall-entry check created an empty destination after
the compiled Linux Host's final check. The Linux Host preserved the directory and its inode,
cleared staging and published the world under a fresh name on retry. The standalone Host also
imported with an empty executable search path. The built Linux desktop ran the same publication
operation through its Bun helper.
[Windows directory rename](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw#parameters)

The packaged Linux Launcher read Minecraft 1.10.2 from the XMCL sample's `level.dat` and warned when
the destination selected 1.9.4. Both layouts required keyboard-accessible confirmation for folder and ZIP
imports. Cancelling published no world. Confirmed imports preserved the sample's level and region hashes
and an existing sibling world. A 1.21.1 destination imported the same sample without confirmation.

Packaged Saves backed up a selected XMCL world whose folder name starts with a space, exported its original
region data in a ZIP, and restored the selected world without changing the other world in the instance.

The packaged Linux Launcher exported a selected XMCL sample world from a Minecraft 26.3 instance and
imported it into one configured for 1.21.1. Cancelling or sending missing or stale version confirmation kept
the live world bytes intact and created no recovery snapshot. Confirming restored only that world and kept
the other world intact. The resulting 1.21.1 recovery snapshot restored the previous bytes without a version
warning. A matching 26.3 destination also used the ordinary restore flow.

The packaged Linux Launcher exported the XMCL 1.10.2 sample from an instance configured for 1.9.4. The portable
backup still recorded the source instance setting. After import into another 1.9.4 instance, restore preview found
the newer release in the level data and required confirmation. Cancelling kept the live worlds and backup history.
Confirmation restored the selected world and preserved its sibling. The recovery snapshot restored the previous
world, and a separate 1.21.1 instance restored the same portable backup without a version warning.

The packaged Linux Launcher detected a one-byte change inside an XMCL region file whose size was unchanged.
Restore kept the selected live world and its sibling and created no recovery snapshot. Export published no
portable folder. The same Save history restored an intact backup and its recovery snapshot while preserving
the sibling world. The failure and recovery were exercised in the compact dark and desktop-width light layouts.

The underlying comparisons and pinned reference sources are in the [research report](research/launcher-overlay-codex.md).
