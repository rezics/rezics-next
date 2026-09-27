# CurseForge acquisition

Deferred by the maintainer on 2026-09-27; low priority.

## Current state

PKG09 is qualified as a relation-modeling case: records authored in the
CurseForge file-dependency shape (required, optional, tool, embedded, include,
incompatible) pass through the real receipt path without duplicate downloads or
lost dependency grain. Live CurseForge capture is skipped. The API-key capture
path (`REZICS_CURSEFORGE_API_KEY`) stays available as an optional advanced-user
configuration; users are never required to supply a key. See
[packages](../../testing/packages.md).

## What was learned

- Every endpoint of the official [CurseForge API](https://docs.curseforge.com/rest-api/)
  requires an `x-api-key`. Third-party services
  [apply for a key](https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key);
  review weighs author earnings, server and CDN load, and author consent to
  third-party distribution.
- [CFWidget](https://cfwidget.com/) is a keyless community service returning
  project information and file lists; it documents no dependency data, states
  limited resources and does not guarantee that data stays available.
- A Minecraft mod file declares its own dependencies (`fabric.mod.json`,
  `mods.toml`/`neoforge.mods.toml` and jar-in-jar metadata), which the PKG07 and
  PKG08 profiles already parse. When the file is obtained lawfully (Modrinth,
  a user-provided file, or the CurseForge CDN where the author allows
  third-party distribution), dependencies can come from the artifact without the
  CurseForge API.
- The CurseForge website's internal JSON endpoints are undocumented, sit behind
  Cloudflare and likely conflict with its terms; they are not a candidate.

## Open decision

Whether the platform operator holds one server-side CurseForge key for
project-level relations and file lists, while dependency truth comes from the
mod artifact itself and author distribution settings are respected, or whether
CurseForge stays artifact-only.
