# REZICS Overlay

The Windows x64 host draws a separate transparent window over the active game client area. It uses WebView2 for its
bundled React UI. Ctrl+Shift+Space opens the panel by default. Escape or **Return to game** hides it and returns focus to the
game. **Pin compact view** switches to a click-through HUD. The hotkey reopens the interactive view from the HUD.
Switching away or minimizing the game suspends the pinned HUD until the same window returns to the foreground.
The hotkey leaves a suspended HUD on its original window even when another window of the game process has focus.
When the game opens a modal prompt, the hotkey leaves the prompt in control and the HUD waits for the game to return.
The host drops a queued hotkey when the foreground window changes before the host handles it.
The interactive panel closes when its top-level window loses activation, including when a WebView control held focus.
Keyboard focus starts at the game title on every opening and is retained when panel content updates. Commands from a
superseded opening are discarded. Closing the tracked window clears the pin.
The host tracks the Win32 client rectangle in screen coordinates, including for mirrored windows and games that
Windows scales on their behalf.
If WebView2 loses its main renderer or browser process, Overlay closes and returns focus to the game when
it still owns the foreground. Launcher restarts Overlay once for the current session.

## Build and check

Build on Windows x64 with Rust, Bun and the WebView2 runtime. The Bun build creates the embedded assets before Cargo
compiles the host. Launcher starts the executable with piped standard streams.

```sh
bun run --cwd apps/overlay build
bun run --cwd apps/overlay check
```

The native Windows output is `apps/overlay/target/release/rezics-overlay.exe`. The build stages the x64
`WebView2Loader.dll` beside the executable from the selected Cargo build. Launcher packaging includes the DLL
when the executable imports it. Protocol and visibility tests run on the ordinary Rust host.

On a machine with the Rust GNU Windows target and linker, build the Windows distributable files together.
Use the resulting `target/x86_64-pc-windows-gnu/release/rezics-overlay.exe` as the Launcher packaging override.

```sh
bun run --cwd apps/overlay build --target x86_64-pc-windows-gnu
```

## Standalone window fixture

Run the [Windows qualification fixture](tools/qualify-windows.ps1) in an unlocked Windows x64 desktop
with WebView2. Use 64-bit Windows PowerShell and an x64 developer shell with `cl.exe` or MinGW
`gcc.exe`. Pass `-Fixture` to reuse an executable built from the current [fixture source](tools/window-fixture.c). Keep the
test windows unobstructed and leave desktop input to the script while it exercises them.

```powershell
powershell.exe -NoProfile -File apps/overlay/tools/qualify-windows.ps1 -Mode Overlay -Overlay apps/overlay/target/release/rezics-overlay.exe
```

The script sends the same v1 session frame as Launcher and records the WebView's ready reply, the attachment
confirmation, exact game client bounds, Ctrl+Shift+Space, Tab, Escape, Return to game, a destination reply and
click-through HUD.
It also checks that the HUD resumes over the same moved or restored game with game focus and click-through input,
while the interactive panel stays closed until the hotkey. The hotkey must leave both an unrelated process and
another window of the game process alone while the HUD is suspended. A game-owned native modal prompt keeps
focus in both hidden and pinned modes. Dismissing the prompt allows the HUD to resume over the original game.
The fixture switches the foreground game to a topmost borderless window at the same client bounds, then back
to windowed mode. The runner checks Overlay's stacking order, game focus, pointer delivery and repinning.
The second game window uses right-to-left layout and Windows-managed DPI scaling. After dismissing the previous
interactive panel, the runner opens Overlay over this window and checks its client bounds, Escape and pointer input.
With multiple displays, the runner moves the main game between displays during an interactive opening and checks
placement, DPI and focus. It records `mixed-dpi-bounds` when the game crosses between different display scales.
Further checks cover a stale timestamp
for the controlled PID, a session update with eight large panels, and game and pipe closure. Each run writes artifact digests,
passed observations and process diagnostics under
`.temp/windows-qualification`. Run the [packaged Launcher fixture](../launcher/README.md#windows-release-qualification)
against the sidecar shipped beside its application archive as well.
The packaged fixture stops the WebView2 browser for its isolated Overlay profile while the panel is open.
It checks that the original game gets focus back and that the Launcher opens a replacement Overlay for
the same running game.
The same command's [Evidence mode](../launcher/README.md#windows-release-qualification) checks that both
fixture reports and the licensed Minecraft record match that candidate's packaged files.

Start a local test window with a visible client area, note the process ID of the window itself and run
`rezics-overlay.exe --fixture <pid>`. Add `--shortcut ctrl-shift-f9` or `--shortcut ctrl-shift-f10` to test a preset.
Focus the fixture and press the hotkey. Verify keyboard navigation, Escape,
the compact HUD, repositioning across monitors, and hiding when switching to another application. Closing the
fixture exits the host. Launcher integration uses the same native host and a live session supplied by the pipe.

The launcher pipe is newline-delimited UTF-8 JSON. Actions, status replies and WebView commands are limited to
16 KiB. The host sends `ready` with its registered shortcut and 32 KiB session frame limit when the WebView is
running. Launcher then sends a session snapshot with up to eight enabled panels. Launcher replaces unpaired UTF-16 code units in
display text before encoding the snapshot. With an older sidecar's `ready` frame, Launcher keeps the 16 KiB
limit and sends panels that fit. The host holds a Windows process handle and checks
its creation time against the reported start time before replying with `session-status` containing the session ID
and an `attached` boolean. Only confirmation for the current session makes the shortcut available. The WebView
receives the session title, permitted destinations and declarative panels. The host validates actions against the
active session and writes destination IDs to Launcher. Launcher resolves approved browser URLs.
[Process creation time](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)

The host registers the selected shortcut before starting WebView2. It reports a registration failure on the
Launcher pipe and exits. To check recovery on Windows, reserve Ctrl+Shift+Space in another app, then launch
the fixture game through Launcher. Select Ctrl+Shift+F9 from the active game panel while the original shortcut
is still reserved. Check that the selected shortcut opens Overlay over the same game process. Release the
original shortcut and select it again to test switching back. Restart Launcher and check that the preference
is retained for the next game session.

If the WebView2 builder reports a runtime startup error, the host sends `webview2-unavailable` before exiting.
When the loader can read an available runtime version, the frame includes `runtimeDetected: true`.
Launcher offers a retry for both failures. It offers Microsoft's download when the frame has no runtime
confirmation, including replies from older Overlay builds.
[Microsoft WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
