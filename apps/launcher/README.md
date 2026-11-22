# REZICS Launcher

Run `bun install` at the monorepo root. Start the desktop app with `bun run --cwd apps/launcher dev`. The
Electron CLI fetches its pinned runtime on first use. It loads the bundled renderer locally and keeps the host
in the tray when its window closes. Use the tray menu to reopen or quit it.

Build the Windows x64 Overlay with `bun run --cwd apps/overlay build` before packaging the Launcher. Run
`bun run --cwd apps/launcher package:windows` for an NSIS installer under `apps/launcher/.temp/installers`.
Use `bun run --cwd apps/launcher package:windows --unpacked` for a Windows fixture directory.
Packaging includes the companion Overlay executable beside the application resource archive. In development,
the Launcher starts the sibling Overlay build for each game session. The active game panel offers the default
**Ctrl+Shift+Space** and two alternate shortcuts. The Overlay uses the Microsoft Edge WebView2 Runtime.
The Overlay build stages the x64 `WebView2Loader.dll` beside its Windows output. Keep both files together when
supplying an Overlay override. The packager checks the executable's import table and includes the DLL when
the executable imports it. An MSVC build with a statically linked loader packages the Overlay executable alone.

| Setting                      | Purpose                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `REZICS_CATALOG_URL`         | Kernel origin or API base URL. Defaults to `https://api.rezics.com`.                                                                          |
| `REZICS_WEB_URL`             | Web origin for linked game pages. Defaults to `https://rezics.com`.                                                                           |
| `REZICS_MINECRAFT_CLIENT_ID` | Approved Microsoft public application ID for Minecraft sign-in. Set it when starting development Launcher or when creating a Windows package. |
| `REZICS_OVERLAY_PATH`        | Override the Overlay executable for development or packaging. Desktop checks can point Launcher at a protocol fixture with this setting.      |

The renderer calls the isolated preload API. Main checks the sender frame and validates method arguments.
Game and Java executables, save folders, JARs and `.mrpack` archives enter through native pickers. Main and the independently
running Overlay exchange bounded JSON lines over child-process pipes. On Electron hosts with OS-backed
credential encryption, the Launcher Core stores the Minecraft account using Electron's encrypted storage.

Run `bun run --cwd apps/launcher check` for TypeScript, formatting and pipe fixture checks. Run
`bun run --cwd apps/launcher build` to build the Electron main, sandbox preload and production renderer.

In **Library**, switch to **Installed**, then choose **Import game**, **Scan a visual novel folder** and **Choose folder**. Review the
detected games and select one executable per folder. Launcher preselects an unambiguous match for the current
platform. Use single game import for unrecognized games. Folder import registers the selected installations and
reports failures per game. You can link an imported installation to its REZICS Subject in Settings.

## Headless Launcher host

The Electron desktop and `host` command use the same local host. Supply the Launcher data folder explicitly.
Keep this folder private to your OS account. The host holds one write lock per data folder. `list-installed`,
`search-vn`, `search-vn-batch`, `discover-vn`, `inspect-vn`, `import-vn`, `link-vn` and the [backup commands](#backups-without-a-window)
connect to the running host when it owns that folder. `serve` runs the same automation service in a terminal
while the desktop is closed.
Local script execution with `run` uses an exclusive host. `read-library` can run with a desktop or terminal
host already open for the same profile.

```sh
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data list-installed
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data serve
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data read-library /absolute/library-query.json
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data discover-vn /absolute/galgames
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data inspect-vn /absolute/games.json
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data import-vn /absolute/selected-games.json
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data search-vn 'The Question'
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data search-vn-batch /absolute/queries.json
bun run --cwd apps/launcher host --data-dir /absolute/launcher-data link-vn /absolute/associations.json
```

The Windows installer places `rezics-launcher-host.exe` beside `REZICS Launcher.exe`. Run the command from
PowerShell with the same explicit profile folder as desktop Launcher. Use a separate profile to operate
independently of the desktop. The executable includes its own runtime and accepts stdin, stdout and stderr.

```powershell
& 'C:\Path To Launcher\rezics-launcher-host.exe' --data-dir "$env:APPDATA\REZICS Launcher" list-installed
```

The installed command accepts the same subcommands. For `run`, supply a JavaScript module such as `operation.mjs`.
Run the host with `--commands` to read its versioned JSON command list. It includes each command's input
form, owning bundled plugin when applicable, and whether it requires a running host. Commands with
`"stdin": "json"` accept `-` in place of the file path. Send one UTF-8 JSON value of up to 16 MiB.
Relative paths in piped JSON resolve from the host command's working directory. For file input they resolve
from the directory containing the JSON file. `read-library` uses a query file and advertises
`"stdin": "credential"`. `--help` prints the command names for terminal use. Both options work without a profile.

```sh
printf '[{"executable":"/absolute/galgames/Story/story.exe"}]\n' |
  bun run --cwd apps/launcher host --data-dir /absolute/launcher-data inspect-vn -
```

`discover-vn` scans a chosen folder for candidate `.exe`, `.sh` and `.py` files. It skips linked paths and
the Launcher data folder. It skips the known engine content and runtime folders of a recognized game
and continues into sibling folders where other installations may be stored. Results group candidates by
directory and indicate when there is one recognized entry, several, none, or an inspection error. Review
the candidates before importing. `platformMatch` checks the executable type and, for scripts, execute
permission on the current OS. `launchEvidence` describes a matched Ren'Py bootstrap or embedded KiriKiri archive.
When the Host can identify a single suggested choice, it returns `recommendedExecutable` for review.
Discovery reports matching local instances. Archived candidates include `archived: true`.

Use a JSON array with an `executable` per game for `inspect-vn` and `import-vn`. Discovery candidates have
the executable and working folder needed for this array. Paths may be absolute or relative to that file. Each row can
set `name`, `workingDirectory`, `saveDirectory`, `renpySaveName` and `subjectId`. Inspection reports engine,
title and save folders when available. Review the results before importing the selected rows. Import returns the
existing instance for a matching executable and working folder. An archived match returns `status: "archived"`
with its existing instance. Restore it to bring it back into Installed. Import leaves the matched instance's
current settings and link in place. Row failures are reported alongside successes and set exit status `2`.

Use `link-vn` for existing installations. Each row supplies `instanceId`, `expectedSubjectId` from
`list-installed` or discovery, and the confirmed `subjectId` from REZICS. Use `null` for an absent or
removed association. The host compares the expected ID before writing, reports conflicts with the current
instance, and treats an already applied association as unchanged. Conflicts and row errors set exit status
`2`. The operation updates the local link and leaves the online Library to REZICS.

Use `host ... run /absolute/operation.ts` to call the typed Launcher Core and Overlay operations from a local
module. Export a default function that receives a `LauncherHost`, available from `@rezics/launcher/host`. This
entry uses in-memory Minecraft credentials. Another host embedding the API can supply an encrypted storage
port. Running games and showing Overlay require their normal operating-system facilities. The command writes URLs
to stderr for the caller to open where needed.

REZICS owns the online Library and its entries. The desktop Library defaults to **REZICS online**, which opens
the existing Web Library. **Installed** is a device filter and includes games with or without a Subject link.
An agent can use available, authorized REZICS CLI or MCP operations for online work and pass selected Subject
IDs to the local host. Those REZICS clients are provisioned independently of Launcher.
For a local batch, start with `discover-vn` or `list-installed`. Query REZICS for ambiguous titles or records,
review the Subject IDs, and use `link-vn` to apply the confirmed associations to existing installations.
Use `search-vn-batch` with a JSON array of up to 100 strings, such as
`["The Question", "018943aa-abcd-4abc-9abc-0123456789ab"]`. A result with `status: "ready"` includes
the query and its `matches` array, which can be empty. A row error includes a message and sets exit status
`2`. Every result includes the input index. Use the IDs from reviewed matches in `link-vn`.

The `read-library` query file takes `kind` as `visual-novels` or `video-games`, an optional `cursor`, and
an optional `installedOnly` boolean. Supply a short-lived REZICS bearer credential with `library_entry:list` and
`progress_session:list` through standard input. Kernel must expose Personal Library and Reading Progress for the
caller. Embedders can provide `readRezicsLibraryToken` on the host options. The command reads
one Kernel page in its own process. For a page with entries, it queries the running host for the local
installation list or opens the profile if it is free. It joins by Subject and applies the Installed filter
locally. Continue with `next` even when a filtered page is empty. An unavailable profile returns
`installations-unavailable` for an Installed read. For an unfiltered read, the same failure keeps the authorized
page and sets `installationsUnavailable: true`. In that case, empty `installations` arrays mean the local matches
could not be read.
When Kernel reports `semantic_not_ready` for the full shelf view, the command retries that page in the basic
view. The response keeps the Subject IDs, cursor and local matches, with null titles and `metadataUnavailable: true`.
The command keeps credentials in its own process memory. [Launcher device authorization](../../docs/accounts.md#4-clients-consent-requests-and-permission)
remains pending, so the desktop opens the Web Library for interactive sign-in.

### Organize local installations without a window

`import-local-game` takes a JSON object with `name`, an absolute `executable`, and optional absolute
`workingDirectory` and `saveDirectory` paths. An optional `subjectId` links the instance to REZICS.
Use `import-vn` for visual novels.

Use `list-installed` to select instances, `archive-local-games` to move them to Archived instances, and
`list-archived-local-games` to find them there. Use `restore-archived-local-games` to bring them back.
Both change commands take a JSON array of objects with an `instanceId`. Each result includes its input
index and reports `archived`, `restored`, `unchanged`, or `error`. A row error sets exit status `2`
and allows the other rows to finish. Close a running game before archiving it.
Restoring keeps the same instance ID, REZICS link, and save history. The executable and actual saves
stay in their current folders. These commands apply to imported games.

### Game Footprints without a window

Use `footprint-status` to read whether local capture is enabled and whether capture failed. To opt in or
out, pass a JSON file with an explicit `enabled` boolean to `set-footprint-recording`. The setting applies
to games started after the change. Capture is off by default and records completed runs of games linked
to a REZICS Subject.

Pass a JSON file with `file` set to a new absolute `.jsonl` path to `export-footprints`. The host exports
the same local format as the desktop, keeps existing destination files and returns the exported path.
The user can import it from Footprints on the REZICS website.

### Visual novel settings without a window

Pass a JSON array of rows such as `[{"instanceId":"game-…"}]` to `read-vn-settings`. Each valid row returns
local settings, detected engine metadata when available and a settings `revision`. The ID comes from
`list-installed`, discovery or import.

Pass a JSON array to `edit-vn`. Each row contains `instanceId`, the reviewed `revision` and a `patch`.
The patch accepts `name`, `executable`, `workingDirectory`, `saveDirectory` and `renpySaveName`. Paths can
be absolute or relative to the request file. Use `null` for the working folder, save folder or Ren’Py save
name to return to its default. Use `link-vn` to update the REZICS association.

Close a running game before editing its settings. Each row returns `changed`, `unchanged`, `conflict` or
`error`. Conflicts and errors set exit status `2` while other rows keep their results. For a conflict, read
the current settings and review your changes again. An already applied edit returns `unchanged`. The same
instance ID and backup history remain available when repairing paths after moving a game.

### Game sessions without a window

Open Launcher or start `serve` for the profile. In terminal mode, wait for the `{"status":"ready"}` line,
then send commands to that same profile from another terminal. The running host owns the game process,
the Overlay and work after game exit.

| Command                   | Argument and result                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-game`              | Instance ID from `list-installed`. Returns the new session after the game process starts. A Minecraft instance needs the usual installation and account preparation. |
| `quit-host`               | No argument. Schedules a terminal host started by `serve` to exit after its game, after-exit work and preparation. Returns `{"status":"quitting"}`.               |
| `game-status`             | No argument. Returns the current `session` or `null`, host `work` state and `overlay` status.                                                                        |
| `launch-report`           | Instance ID. Returns the last launch state, exit code, signal and optional issue kind and recovery action, or `null` before the first launch.                        |
| `launch-log`              | Instance ID. Returns the same filtered text as **Copy diagnostics**, or `null` before the first launch.                                                              |
| `stop-game`               | The exact live session ID. Force-stops that session. Wait for `game-status` to report `idle` before assuming that after-exit work has finished.                      |
| `restart-overlay`         | The exact live session ID. Requests a restart and returns the current Overlay status.                                                                                |
| `overlay-preferences`     | No argument. Returns whether Overlay starts with games and the saved shortcut. Works while the profile is idle.                                                      |
| `set-overlay-preferences` | JSON file with boolean `enabled`, `shortcut`, or both. Returns the saved preferences and applies them to the current game.                                           |
| `set-overlay-shortcut`    | JSON file with the live `sessionId` and `shortcut`. Use `ctrl-shift-space`, `ctrl-shift-f9` or `ctrl-shift-f10`.                                                     |

An unavailable Overlay reports its startup or attachment failure in `game-status` while the game continues.
Use `quit-host` from another terminal to request shutdown of the Host process across platforms. While it
waits, `game-status` includes `quitPending: true`, and `stop-game` still accepts the current session ID.
The installed list, save history and launch diagnostics remain readable until the host closes the profile.
Use the Minecraft preparation commands to inspect or cancel an accepted preparation by attempt ID.
When Minecraft writes a new crash report, `launch-report` includes a `crashReport.truncated` flag.
Use `launch-log` for the filtered crash excerpt and process output.
Use the current session ID when correcting a hotkey conflict or restarting its Overlay.
Open **Extensions** and **Overlay settings** to choose the same preferences in the desktop. A game
running with Overlay turned off reports `overlay.state: "disabled"`. Re-enabling starts it for that
same game. The shortcut can be set while Overlay is off or while no game is open.

### REZICS packages and Overlay extensions without a window

Pass a JSON file with `kind` of `overlay-panel` or `minecraft-mod` and optional `query` and `cursor` to
`search-rezics-packages`. Use `rezics-package-releases` with `packageId` and an optional `cursor` to list
published releases.

Pass the exact `packageId` and `releaseId` to `preview-rezics-package`. Include `instanceId` for a curated
Fabric mod. The preview lists the requested release and its dependencies, their planned changes and
artifact hashes. Pass the preview JSON to `install-rezics-package`. Installation rechecks the reviewed
plan and verifies each downloaded artifact. Refresh the preview after a catalogue or local package change.
On desktop, use **Versions** on an installed extension or managed online mod to review another release
without searching again. The review lists dependencies and any disabled release that the replacement
will enable.

When Modrinth rate limits a request, the desktop and Host CLI report how long to wait. Mod and pack commands
share that interval for the affected Modrinth service. Retry the command after the delay. A temporary service
outage or a missing release has a separate message.

`list-overlay-extensions` lists installed panels in display order, including each panel's `revision`,
any `fileIssue`, and whether the panel appears in Overlay. Pass the exact `packageId` and current `revision`
to `repair-overlay-extension`, `set-overlay-extension-enabled` with a boolean `enabled`, or
`uninstall-overlay-extension`. Repair uses the installed release and keeps its enablement and position.
The desktop offers **Repair extension** for a missing or damaged panel.
Use the up and down buttons to change display order, or pass `packageIds` in the desired order and the
shared `orderRevision` from `list-overlay-extensions` to `reorder-overlay-extensions`. Include every
installed extension exactly once, including disabled ones. If the order or membership changed, list
the extensions again before retrying.
Disable or remove any enabled dependents before disabling or removing their required extension. The desktop
Extensions list and the active Overlay update after a successful change.

### Minecraft without a window

Start `serve` to keep authorization, preparation and launch in the same host. These commands also work
against the running desktop. For selection, use the exact game and loader releases returned by the catalogue.

| Command                                                | Argument and result                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minecraft-versions`                                   | No argument. Lists stable game releases and marks the latest.                                                                                                 |
| `minecraft-loaders`                                    | JSON file with game `version` and `loader`. Returns the available Fabric, Forge or NeoForge releases for that game release.                                   |
| `create-minecraft`                                     | JSON file with `name`, `loader`, optional `version`, and the matching `fabricVersion`, `forgeVersion` or `neoForgeVersion` if selected. Returns the instance. |
| `set-minecraft-settings`                               | JSON file with `instanceId` and any of `maxMemoryMiB`, `accountId` and `useManagedJava`. Returns the updated instance.                                        |
| `set-minecraft-java`                                   | JSON file with `instanceId` and an absolute Java `executable` path. Saves the path after checking compatibility with the instance's release.                  |
| `check-minecraft-java`                                 | Instance ID. Checks the selected runtime and returns its compatibility, preparation requirement or repair action.                                             |
| `prepare-minecraft`                                    | JSON file with `instanceId` and `mode` of `install` or `repair`. Returns the tracked attempt.                                                                 |
| `minecraft-preparation`                                | Instance ID. Returns the attempt, including its current phase and progress, or `null`.                                                                        |
| `cancel-minecraft-preparation`                         | JSON file with `instanceId` and the active `attemptId`. Returns the current attempt after requesting cancellation.                                            |
| `start-minecraft-sign-in`                              | JSON file with `{}` for a new sign-in or an `accountId` to reconnect. Returns the current authorization state.                                                |
| `minecraft-sign-in-status`                             | No argument. Returns the live state. A failed sign-in returns a JSON error state and exit code 2.                                                             |
| `cancel-minecraft-sign-in`                             | No argument. Cancels the pending authorization before the profile is saved.                                                                                   |
| `minecraft-accounts`                                   | No argument. Lists public profile details and the active account.                                                                                             |
| `select-minecraft-account`, `forget-minecraft-account` | Exact account ID. Returns the resulting profile list and default.                                                                                             |

Checking Java uses the installed release's recorded Java requirement. For a new instance, it reads the exact
release's metadata. The check returns `ready`, `needs-preparation` or `invalid`. The `invalid` state
includes a recovery action and exits with status `2`. Close Minecraft before checking a managed runtime.

In the waiting state, the account holder visits the displayed Microsoft address and approves the displayed user code.
Account and entitlement checks use the approved Microsoft client ID configured for the host. The terminal host
keeps credentials in memory for its lifetime. Credentials held by the desktop use its existing protected store
when available. When preparation reports `ready` and sign-in has completed, use `start-game` for the instance.

### Minecraft instance management without a window

Use `list-installed` to get instance IDs. Close Minecraft before managing an active instance.

| Command                      | Argument and result                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rename-minecraft`           | JSON file with `instanceId` and `name`. Returns the renamed instance with its original ID.                                                                                                    |
| `duplicate-minecraft`        | JSON file with `instanceId`, `name` and explicit `copyWorlds` set to `true` or `false`. Returns the new independent instance with its own ID.                                                 |
| `archive-minecraft`          | Active instance ID. Moves the instance, worlds and backups into the archive and returns `status: "archived"`.                                                                                 |
| `list-archived-minecraft`    | No argument. Returns archived instances with their current `revision`.                                                                                                                        |
| `restore-archived-minecraft` | Archived instance ID. Moves the same instance, worlds and backups back into Installed.                                                                                                        |
| `delete-archived-minecraft`  | JSON file with the reviewed `instanceId`, its current `revision` and `confirmInstanceId` matching the selected ID. Permanently removes the archived instance and returns `status: "deleted"`. |

Duplicating keeps the original instance and makes independent settings and mod files. World copies are opt-in.
The new instance starts with its own backup history. Review the current archive row before permanent
deletion. Restoring and archiving the same instance again gives it a new archive revision.

### Minecraft version changes without a window

Pass a JSON file to `preview-minecraft-version-change` with `instanceId`, exact `selection`, and a `mode` of
`in-place` or `copy`. Use `{"version":"1.21.1","loader":"vanilla"}` for Vanilla. Include the exact
`fabricVersion`, `forgeVersion` or `neoForgeVersion` when selecting that loader.

For a copy, supply `worldIds` from `list-worlds`. Use `[]` for a clean instance or omit the field to resolve all
available worlds at preview time. The preview returns the exact IDs it will copy. To override the instance's
Java policy, pass `{"kind":"managed"}` or `{"kind":"custom","executable":"/absolute/path/to/java"}` as `java`.

The preview returns the source and destination release, Java policy, any `inPlaceBlocker` or
`worldVersionRisk`, and a review `revision`. If a blocker is present, preview a separate copy. After reviewing
a world version warning, add its value as `worldVersionConfirmation`. Pass the reviewed JSON to
`start-minecraft-version-change` against `serve` or the running desktop. Both modes require the game to be closed.

`minecraft-preparations` lists active and interrupted work across instances. Use `minecraft-preparation`
with the source instance ID for progress or `cancel-minecraft-preparation` with the exact attempt ID to cancel.
A successful version change reports `resultInstanceId`, which identifies the new instance for a copy.

### Minecraft mods without a window

Use the instance ID from `list-installed`. Search and version listing use the instance's game release
and loader. Close the game before changing its mods.

| Command                         | Argument and result                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `minecraft-mods`                | Instance ID. Lists managed mods, exact online release IDs, enablement and any file issues.                           |
| `search-minecraft-mods`         | JSON file with `instanceId` and `query`. Finds compatible Modrinth projects.                                         |
| `minecraft-mod-versions`        | JSON file with `instanceId` and `projectId`. Lists compatible Modrinth releases.                                     |
| `preview-minecraft-mod-install` | JSON file with `instanceId` and `versionId`. Returns the exact release and dependency changes with their `revision`. |
| `install-minecraft-mod`         | Same fields plus the reviewed `revision`. Installs that plan and returns `status: "installed"`.                      |
| `preview-minecraft-mod-state`   | JSON file with `instanceId`, `packageId` and boolean `enabled`. Returns the affected managed mods and a `revision`.  |
| `apply-minecraft-mod-state`     | Same fields plus the reviewed `revision`. Applies the group and returns the requested state.                         |
| `import-minecraft-mod`          | JSON file with `instanceId` and an absolute JAR `file` path. Adds a managed local mod.                               |
| `repair-minecraft-mod`          | JSON file with `instanceId` and `packageId`. For a local mod, include the original JAR's absolute `file` path.       |
| `remove-minecraft-mod`          | JSON file with `instanceId` and `packageId`. The host checks whether another enabled mod requires it.                |

Review the new plan if the provider release or installed state changes. Use the distinct managed
`packageId` from `minecraft-mods` for state changes, repair and removal.
Press Ctrl+C during `install-minecraft-mod` or `install-rezics-package` to cancel staging. If the host
has started publication, it finishes or recovers the transaction. Read the installed list after an
interrupt to see the committed release. On desktop, **Cancel installation** keeps the review available for retry.

Use `minecraft-mod-folder <instance-id>` to inspect the actual JARs and repeated IDs in a modded
instance. For manual files with a `revision`, pass a JSON file to `set-minecraft-mod-file` with
`instanceId`, the exact current `name`, boolean `enabled` and that `revision`. The reply contains the
resulting file name and state. Rescan after an external change.

### Minecraft packs without a window

`search-minecraft-packs` reads a JSON file with `query` and optional `cursor`.
`minecraft-pack-versions` takes `projectId` and optional `cursor`. Both return a page and its next cursor.

Pass a JSON file to `preview-minecraft-pack` with a `source` and `target`. A local source is
`{"kind":"file","file":"/absolute/path/pack.mrpack"}`. An online source is
`{"kind":"modrinth","projectId":"…","versionId":"…"}`. Choose one target.

- `{"kind":"new"}` creates a separate instance.
- `{"kind":"existing","instanceId":"…"}` applies a pack to a closed instance on the same exact game and loader versions.
- `{"kind":"copy-worlds","instanceId":"…","worldIds":["…"]}` installs into a separate instance and copies only
  the selected worlds from the closed source. Get world IDs with `list-worlds`.

New instances use managed Java by default. Include an absolute `javaExecutable` in the request to select
custom Java for a new or copied instance. The preview returns the pack, its selection and files, the target,
and the review `revision`. Pass the reviewed output as the JSON input to `install-minecraft-pack`.
If the copy preview includes `worldVersionRisk`, add that value as `worldVersionConfirmation` after approval.
Install checks the same archive and choices again. An online install fetches and verifies the selected archive
again so the preview can release its staging files.

`minecraft-pack <instance-id>` reads the installed pack. `repair-minecraft-pack <instance-id>` verifies and
repairs its files. `export-minecraft-pack` takes a JSON file with `instanceId` and an absolute `.mrpack` `file` path.
The export contains the pack references and original overrides. Ctrl+C interrupts install or repair before
publication. Once publication starts, the host finishes the transaction and the installed pack reports its outcome.

### Minecraft worlds without a window

Pass a JSON file to `preview-minecraft-world` with `instanceId` and either
`"source":{"kind":"folder","path":"/absolute/path/to/world"}` or
`"source":{"kind":"zip","path":"/absolute/path/to/world.zip"}`. Add `name` to choose the destination
folder name. Without a name, the preview suggests an available folder name for the source. The preview
returns the name being reviewed, the exact destination release, the world details and a review
`revision`. Close the game that owns the source folder and the game that will receive the copy.

Pass the preview JSON to `import-minecraft-world`. If it contains a `versionRisk`, review the two releases
and pass that value as `worldVersionConfirmation` to proceed. The host checks the source and the destination
release again and requires an available world folder name. Changes to the reviewed choices require a fresh
preview.

Use `list-worlds` to get an exact world ID. Pass `instanceId`, `worldId` and an absolute ZIP `path` to
`export-minecraft-world`. The parent folder must exist and the ZIP destination must be available. Use the
resulting ZIP as the source for a preview in a different instance.
Press Ctrl+C to interrupt preview, import or export before publication. The host clears staged files.
Once it submits the final file operation, check `list-worlds` or the ZIP destination for the outcome.

### Backups without a window

Use the instance ID from `list-installed`. These commands print JSON and work with a desktop or terminal
host that already owns the profile. The game must be closed to create or restore a backup.

| Command                  | Argument and result                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `list-backups`           | Instance ID. Returns the readable snapshot records.                                                                               |
| `backup-history`         | Instance ID. Returns `snapshots` and `issues`. Issues set exit status `2`.                                                        |
| `read-automatic-backups` | JSON array of objects with `instanceId`. Returns each instance's current automatic backup state or a row error.                   |
| `retry-automatic-backup` | Instance ID. Runs the automatic backup with the game closed and returns the resulting checkpoint.                                 |
| `list-worlds`            | Minecraft instance ID. Returns the selectable world IDs.                                                                          |
| `create-backup`          | JSON file with `instanceId`, optional `label` and optional `selection`. Returns the created snapshot.                             |
| `set-backup-pinned`      | JSON file with `instanceId`, `snapshotId` and boolean `pinned`. Returns the requested pin state.                                  |
| `delete-backup`          | JSON file with `instanceId` and `snapshotId`. Deletes an unpinned backup and returns `status: "deleted"`.                         |
| `export-backup`          | JSON file with `instanceId`, `snapshotId` and `folder`. Returns the exported bundle's `path`.                                     |
| `import-backup`          | JSON file with `instanceId` and `folder`. Returns the imported snapshot.                                                          |
| `preview-restore`        | JSON file with `instanceId` and `snapshotId`. Returns destinations, any version warning and a review when the selection is ready. |
| `restore-backup`         | JSON file with `instanceId`, `snapshotId` and the approved preview's `review`. Returns `status: "restored"` after completion.     |

History reads snapshot metadata and leaves both backup files and the live restore journal in place.
An `invalid-metadata` issue means the record could be read but failed validation. An `unavailable` issue
means the folder or its record could not be read.

To back up one world, pass `"selection": {"kind": "world", "id": "Exact world ID"}`. Omit it to back up the
instance. To choose visual novel destinations, pass the preview's `visualNovel.choices` with the intended values
as `choices` in another preview request. A `null` target leaves that source in the backup. Review the new
`targets` before applying. If the approved preview contains `minecraftVersionRisk`, pass that object as
`confirmation` when restoring. When a target changes, obtain a fresh preview.

For an export, supply an existing parent folder. Launcher creates a new bundle inside it. For an import,
supply the bundle folder itself. A relative `folder` is resolved from the request file's directory. Import
adds to the receiving instance's history. Use `preview-restore` and `restore-backup` to apply the backup to its saves.

Use `read-automatic-backups` to inspect a batch without reading each snapshot history. A successful row has
`status: "ready"` and a `backup.state` of `idle`, `running` or `failed`. Failed backups provide a message.
A row error sets exit status `2` and leaves the other rows available. After resolving the failure, use
`retry-automatic-backup` for the selected instance. A retry can reuse the latest valid unchanged automatic
checkpoint.
Game exit with no save folder creates no checkpoint and reports `idle` unless an earlier automatic backup
failure is still recorded. An explicit retry reports the missing folder to the caller.

## Windows release qualification

Use an unlocked, dedicated Windows x64 desktop with WebView2 and the release candidate. Run the
[standalone Overlay qualification](../overlay/README.md#standalone-window-fixture), then point the launcher
mode at the unpacked executable. For an installer release, install the same candidate on the test machine
and repeat with the installed executable and its adjacent resources.

```powershell
powershell.exe -NoProfile -File apps/overlay/tools/qualify-windows.ps1 -Mode Launcher -Launcher 'apps/launcher/.temp/installers/win-unpacked/REZICS Launcher.exe'
```

In **Library**, select **Installed**, then **Import game** and **Other local game**, and select the printed fixture executable in the
native picker. Import and play it. The script reserves the default Overlay shortcut in a fixture process,
checks the conflict, selects F9 in Launcher and opens and closes Overlay over the same game. It releases
the reservation and checks the default shortcut again. It runs the packaged host command and checks that
the disposable desktop profile reports the same local instance. It then closes the game and observes the exit log and
automatic backup. When prompted, preview that backup
in **Saves** and restore it. The script compares the restored checkpoint and checks the recovery snapshot.
It writes evidence and the disposable profile under `.temp/windows-qualification` and closes the
processes it started or identified as its own fixture children. Use its isolated library and save folder
for this run.

The fixture uses loopback catalogue and web origins. Record official provider and licensed-account
qualification separately on the packaged Windows candidate with a disposable library and test worlds.
Package the approved Microsoft public-client ID and use a tester-owned licensed Minecraft Java account.
The installed Launcher reads the client ID from `resources/minecraft-client-id.txt`. A package built before
approval can run the local fixtures. Evidence mode reports its authentication configuration as blocked.
The tester completes device sign-in themselves. Reload Launcher with a code pending, then approve in
the browser. Check that Launcher shows the same code before approval and the verified profile after
approval. Keep the device code, account secrets and encrypted account files out of the evidence.

Cover the current stable Vanilla release, Fabric on Minecraft 1.21.1, Forge on 1.20.1, and NeoForge on
1.21.1. Record the exact Minecraft, loader and Java selections, Windows build, candidate digest, and
entry into a test world after sign-in and after a second launch. Exercise cancellation and retry,
verification and repair of a controlled damaged download, compatible mods or pack state where the lane
supports them, and a selected-world restore with a sibling world present. Record failures and their
actual diagnostic or preparation states. Use the same test profile for first launch and relaunch.
The [desktop Goal](../../docs/goals/launcher.md) defines the release conditions for this evidence.

Keep the two native fixture reports and a `licensed-minecraft.json` record together. The evidence command
reads `qualification.json` from the report directory and its immediate subdirectories. It compares artifact
hashes with the supplied Launcher, its headless executable and its packaged resources, including the Minecraft client ID file.

```powershell
powershell.exe -NoProfile -File apps/overlay/tools/qualify-windows.ps1 -Mode Evidence -Launcher 'apps/launcher/.temp/installers/win-unpacked/REZICS Launcher.exe' -EvidenceDirectory '.temp/windows-qualification'
```

Create the licensed record from the actual tester's results. Set `schemaVersion` to `1`, `platform` to
`windows-x64`, and copy the evidence command's `artifacts` object for that candidate. For a native attempt,
record `runtime` as `native` and `windowsBuild` as a string such as `26100.1234` with the actual build number.
Use a `lanes` array with one entry for each `loader` of `vanilla`, `fabric`, `forge`, and `neoforge`.
Each entry has a `status` of `passed`, `failed`, or `blocked`. Include a brief non-sensitive `reason` for a
failure or missing prerequisite. When all entries are blocked, the Windows build and runtime can be omitted.

For a passing lane record the exact `gameVersion`, the `loaderVersion` for a modded lane, and
`java` with a `policy` of `managed` or `custom` and a numeric `major`. For current stable Vanilla set
`releaseType` to `release` after comparing the picker to the released version. In each lane, `checks`
lists the outcomes observed.

- `licensed-sign-in`, `install-or-import`, `progress`, `cancel-and-retry`, and `repair`.
- `world-entry`, `second-launch`, and `selected-world-restore`.
- For modded lanes add `compatible-content` and `content-interruption-and-retry`.

Evidence mode can run on other hosts with PowerShell. It checks recorded outcomes and candidate identity.
It reports missing files or lanes, unverified or mismatched reports, and recorded blockers or failures
separately. A nonzero exit means the evidence is incomplete. Keep the native results and relevant test
observations for review.
