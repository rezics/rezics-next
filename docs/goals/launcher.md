# Mature desktop Launcher

## Outcome

A player can create or import an isolated game, sign in where the game requires it, prepare compatible files,
launch and recover from failures, and manage the game's mods and saves. The desktop and Overlay use REZICS
components. First-party features can ship with both a React frontend and a desktop backend contribution.

The [Launcher owner contract](../launcher.md) defines shared UI, plugins, supported Minecraft lanes, data
custody and distribution. The [Minecraft source comparison](../research/minecraft-launcher-maturity-codex.md)
records the upstream evidence for the supported journey and provider boundaries.

## Done when

- A caller can operate the Launcher host without opening its window. A batch of local visual novels can be
  inspected, selected and imported with stable instance IDs on retry. The desktop Library defaults to the online
  REZICS Library. Its Installed filter shows local games, which can link to online entries by Subject ID.
  Agents can combine Launcher host commands with authorized REZICS CLI or MCP operations where provisioned.
- Desktop and Overlay use the shared theme and interaction components. Native session, focus and window
  behavior have fixture coverage. Every stock feature remains reachable through the actual packaged entry.
- Multiple bundled plugins exercise the same contribution contract. A game plugin supplies its instance and
  settings UI and its backend adapter. A shared plugin supplies another surface or operation. Main owns
  process, filesystem, credentials and IPC authority.
- The selected Windows Minecraft lanes support exact version and Java selection, authorized sign-in, install
  or import, progress and cancellation, file repair, world entry and a second launch. A player's exact
  compatible mods and pack state survive interruption and retry. The Launcher explains an incompatible
  selection or failed process using its actual evidence.
- A local VN shows available metadata for the chosen install and can link to a selected REZICS Subject.
  A fixture and a representative Ren'Py installation exercise known and unknown metadata paths.
- Players can browse, retain or delete backups, recover a specific selected Minecraft world or VN save,
  and move a portable backup to another local installation. Tests preserve unrelated worlds, instances
  and files across restore and interruption.

## Ownership and verification

`apps/launcher`, `apps/overlay`, `packages/launcher-core` and `packages/launcher-contract` own desktop entry
points, lifecycle and bundled features. Reuse `packages/ui` and `packages/client` within their existing ownership.
The Kernel distribution module owns published releases and artifact metadata.

Verify the shared UI at desktop widths in both themes. Use a fixture executable and recorded provider
responses to exercise process output, per-instance recovery, plugin and search paths, and denied or damaged
artifacts. Verify the Windows target with the packaged Launcher and a native fixture. Record real-game
qualification independently from fixtures.

## External conditions

Release qualification still needs an installed Windows x64 run with WebView2 to verify Overlay hotkeys, focus
and input. Licensed Minecraft qualification also needs the REZICS public-client app approved for Minecraft
Services and a licensed Java account to verify sign-in, world entry and a second launch. Provider integrations
follow their own approval and distribution rules.

The desktop opens the REZICS Web Library for sign-in. The Host's authorized shelf read was exercised against
a local Kernel. A live interoperability check requires a provisioned REZICS CLI or MCP session.
