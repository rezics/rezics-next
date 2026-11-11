# Studio

`/studio` mounts one authoring workspace for novel chapters and columns. It reuses the Studio document editor,
preview, saved revision comparison, and private draft revision writer. The route opens hosted books from the signed-in
owner inventory and opens an existing column draft from **Open in Studio** on the drafts page.

Books add the hosted catalogue's complete bounded table of contents and its current publication. Structure edits use
the generated hosted catalogue create/revise operations. Publication review freezes the selected exact chapter
revisions and required ancestor parts; the generated publish operation checks the expected structure and current
publication in one native command. The review shown by the browser is local selection context, not a server-issued
review token. A successful publication is re-read through the owner resource and compared with the reviewed selection.
The native API does not provide publication timestamps or a publication history list, so Studio shows only the current
publication and leaves its timestamp empty.

The existing Post API supplies current document reads, exact revision reads/history, and conditional private draft
revision writes. A Post's conversation title cannot be changed through that revision writer. Content does not yet
provide project document inventory or title-only draft creation, so Studio opens only owner-admitted existing drafts;
draft creation remains in the owning Content flow. Reviewed article publication is also unavailable in the current
Content API. Studio states this limitation instead of treating an empty publication list as complete history.

The native adapter calls the installed generated `KernelClient` routes directly and validates their external responses.
Generated clients are not hand-edited. Remaining producer obligations are: add Content project inventory and
title-only draft creation for in-workspace document creation, add a reviewed article publication operation, and expose
hosted publication history with timestamps if Studio needs those records.

Decision: one mounted Studio flow uses the native Hosted Catalogue structure and atomic book publication with shared Post revision editing; Content inventory, draft creation and reviewed column publication, plus hosted publication history timestamps, remain producer obligations.
