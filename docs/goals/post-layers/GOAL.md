---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch). Migrations are not listed:
# each task reserves its own numbers. Shared readers (work, access, search, library, web work page) are claimed per task.
areas:
  - services/main/src/modules/structure/**
  - services/main/src/modules/content-publication/**
  - services/main/src/modules/studio/**
  - services/main/src/modules/work-contents/**
  - services/main/src/modules/continue/**
  - services/main/src/modules/post/**
  - services/main/src/routes/studio.ts
  - services/main/src/routes/posts.ts
  - apps/web/features/studio/**
  - model/definitions/post-*
  - docs/contracts/work-and-release.md
  - docs/contracts/creation.md
  - docs/contracts/composition.md
---

# Posts, texts and Works

A chapter is a Post placed in its Book, not a Work. People publish, edit,
read, discuss and track chapters exactly as before, while the catalogue holds
only Works that evidence identifies: a thousand-chapter novel is one Work, not
a thousand and one.

The decision and its reasons are in
[Posts, texts and Works](../../contracts/work-and-release.md#posts-texts-and-works):
the Work, the Post's text, the Post (the act and its record) and its
occurrences in compositions are four layers. [state.md](state.md) records
where the work stands.

## Basis

The code mints a full Work, a metadata-only Main Version, `schema:isPartOf`, a
maintainer set and revision anchors for every Studio chapter
(`services/main/src/modules/structure/change.ts`, `routes/studio.ts`), because
Main admits Content only on a `schema:CreativeWork` with a Main Version and a
Book chapter occurrence must have a target. About twenty catalogue reads then
filter chapter Works back out, and about seventeen map a chapter Work back to
its Book. Progress, reading position, notifications, feed cards, rankings and
the reader URL are already keyed on the occurrence.

## Milestones

The manager revises them. A milestone counts when merged, its checks pass and
its journeys pass through the API and in a real browser against the local stack.

- **P1 Post layer.** `rv:Post` holds Content variants, custody, rights,
  disclosure, protection and erasure; Studio chapter creation creates a Post
  and places it; no command mints a chapter Work; existing chapter Works become
  Posts under the same IRIs, so Content, progress, comments and rights keep
  their keys; every reader that filtered or folded chapter Works reads Posts
  through their occurrence, and the filters and `isPartOf` chapter semantics are
  gone.
- **P2 Surfaces.** Studio, the reader, the Work page, Manage, feed cards and
  search show chapters as Posts of their Book with no change a reader would
  notice except that chapters no longer appear anywhere as Works.
- **P3 Author's notes.** A chapter Post carries an optional note before and
  after its text as separate parts: excluded from length, search snippets of
  the chapter text, translation basis and releases of the Work, shown by the
  reader and editable in Studio.
- **P4 Identification.** A Post that evidence identifies as a Work of its own
  (separate authorship, standing alone under its own title, separately
  translated, published or cited) can be linked to a new or existing Work
  through a governed command, without moving the Post's text, custody,
  comments or occurrences.
- **P5 Convergence.** The owner documents state the layers; code comments and
  tests no longer describe chapters as Works; nothing task-named remains.

Acceptance: a serial with chapters by two writers; one Post placed in two Books;
a thousand-chapter Book whose catalogue, author page, Zone browse and search
show one Work; migration of seeded chapter Works with progress, comments and
rights intact; a chapter with author's notes in two languages; a one-shot
chapter identified as its own Work.

## Out of scope

Realm discussions and replies already hold Content without being Works; folding
them into `rv:Post` is a later convergence, not this Goal. Guides
(`schema:DigitalDocument`) and other standalone native Works stay Works.

## Models

Opus 5.5 (the manager) designs and reviews. GPT-6.1 Sol on `codex` is the main
backend worker; frontend goes to Sonnet 5.5 when Claude dispatch is open,
otherwise to Sol or Cursor; Grok takes bounded mechanical work.

## Completion

The Goal ends when P1–P5 pass and the maintainer agrees, or when the maintainer
stops it, closing with `task goal -- goal close post-layers`.

## Constraints

The [manager charter](../manager.md) gives the authority and standing
directions; the [Goal program](../README.md) runs the workers; workers follow
the [worker protocol](../worker.md). One new kernel type, `rv:Post`; no new
service, store or generic resource abstraction.
