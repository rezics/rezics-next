# REZICS Launcher Host notices

`rezics-launcher-host.exe` embeds the Bun runtime. Bun's license file lists its linked libraries and explains
how to rebuild Bun against a modified copy of JavaScriptCore and WebKit. [Bun source and license](https://github.com/oven-sh/bun/blob/main/LICENSE.md)

The REZICS Launcher source and its build configuration are available from the REZICS repository. To create the
host with a rebuilt Windows x64 Bun executable, run the following command in `apps/launcher` of the corresponding
REZICS checkout. Place the output beside `REZICS Launcher.exe` so it can find the installed resources.
[REZICS Launcher source](https://github.com/rezics/rezics-next/tree/main/apps/launcher)

```powershell
bun build scripts/host.ts --compile --compile-executable-path 'C:\rebuilt\bun.exe' --define REZICS_PACKAGED_LAUNCHER_HOST=true --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile rezics-launcher-host.exe
```
