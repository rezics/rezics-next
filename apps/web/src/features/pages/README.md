# Subject page composition

Subject templates place review and discussion regions through the shared community reader. The native page owns
identity, order, continuation and disclosure; the reader projects bounded titles, author ids, timestamps, plain-text
excerpts, first-post citations and reaction fields without retaining post bodies.

`voteCitation` is historical first-post context. It is not the author's current rating. Omitted reaction counts mean
the count projection is unavailable; omitted kinds inside a supplied count object are zero. An absent viewer slot is
withheld, while an explicit `null` means the current reader has no reaction. The existing `ThreadReactions` engine is
mounted only when counts and an explicit viewer slot are admitted. Public page output removes viewer slots; private
reader-keyed page results keep their no-store boundary.

Subject community leaves retain their native cursor and five-row overview/twenty-row full-page limits. One shared
author batch serves each composition page. Mounting a reaction control adds no initial read. Missing reply-count and
last-activity fields stay unavailable under the Content-owned conversation-activity contract; timestamps and loaded
page length do not stand in for them. See the [Web page requirements](../../../../../docs/goals/web.md#adopted-core-page-experience-requirements).
