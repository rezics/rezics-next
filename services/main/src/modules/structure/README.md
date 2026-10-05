# Structure ownership

A Structure records occurrences of resources rather than owning their content.
Book chapters are Posts: their publication, custody, text and discussion stay
with the Post, while order, labels and private reading progress stay with each
occurrence. Reuse therefore creates another placement without copying content
or minting a Work. An independently maintained Work can also be placed in a
Book; placement alone never changes its identity. See the
[Post identity decision](../../../../../docs/contracts/work-and-release.md#posts-texts-and-works).

Owner profiles keep authorization and target selection with the capability
owner. Book uses a Work/Main Version adapter; other owners can attach a
Structure directly. The shared command code retains order, revision and
receipt behavior so an owner does not duplicate those mechanics.

Order edits stay local to a bounded segment to avoid renumbering a whole Book.
Large replacements use resumable stages: an unselected generation can be built
and recovered before one guarded head switch makes it visible. Creation of an
owner and its Structure uses durable receipts rather than compensating
deletion, preserving an independently created owner when the second step needs
a retry. The schemas, cost contracts and adjacent tests carry the bounds and
recovery assertions.
