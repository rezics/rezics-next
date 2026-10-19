# Maintainer direction: independent conversion and source annotation

The maintainer clarified these boundaries on 2026-10-19. They supersede the
conflicting recommendations in the first module-design review draft and older
task briefs. This is a settled architectural direction, not a new approval hold.

## Confirmed boundaries

- External-format conversion belongs in a standalone library that clients and
  import tools can use. It is not built into Main's ordinary business modules.
- The server may call that same library through a separate, explicit conversion
  interface. Ordinary native interfaces accept native contracts and perform no
  automatic external-format conversion.
- Conversion and source annotation are independent capabilities. An annotation
  does not require a converter run, conversion ID, mapping registration or
  converter-produced proof. Native data can be authored directly and cited later;
  a converter can produce native data without submitting annotations.
- Source annotation can validate its admitted target and references without
  re-running a provider conversion. Citation, retained evidence, automated
  derivation and verification have different meanings.
- The user-facing reference is Wikipedia: inline citation markers and a collected
  reference list at the end. The exact model, editor representation and rendering
  follow academic and engineering research; the reference is not a mandate to
  copy Wikipedia's entire implementation.

## Manager actions

Program delegates the research and consolidates its results for the maintainer;
Program does not author another speculative provenance framework. Separate
codex-2 / GPT-6.1 Sol / max researchers cover academic provenance/citation models,
Wikipedia/Cite and library implementations, and the repository/API boundary.

Both audit managers continue unrelated authorized repairs and original proof.
The catalogue manager immediately reads and re-briefs the existing Source and
import owners where needed: do not promote server-owned provider mappings or
conversion-dependent citation contracts into the final design. Preserve authored
work and real identities. Use native writes and independent annotation calls;
the standalone library may be called explicitly by the importer or an optional
conversion endpoint. Coordinate necessary pure-code extraction through existing
owners after consuming the research, without a second native engine or a general
workflow/mapping framework. Changes to the source annotation abstraction remain
research proposals for maintainer review until a concrete recommendation exists.

Research reports must separate primary-source findings, local code observations,
recommendations and unvalidated choices. The consolidated review must explain
the minimal citation record, exact target granularity, editing/version behavior,
reuse of a reference, independent withdrawal, privacy, and inline/end-list use.
The original audit completion target remains 16:00 Asia/Shanghai; this correction
does not stop unrelated implementation or authorize weaker acceptance.
