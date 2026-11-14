# Member reading

`MemberListRow` remains the `ContentItem` adapter for Search and other supplied member lists. It keeps its
semantic title, stretched primary link, decorative cover and independent metadata and trailing controls.

Decision: `MemberReadingItem.detail` places the one selected occurrence's supplied `MemberReadingDetail` after
its compact list row or inside its grid card's normal content flow; opening preserves focus and viewport.

The list outlet occupies the row's full width after the summary and Inspect control. It is outside the clamped
summary and above the stretched primary link, so full notes, facts and reference controls remain readable and
independently hittable. The grid outlet follows Inspect inside the card content, including placeholder and
unavailable members. Its height contributes to the grid row; subsequent items and continuation follow that row.
Do not absolutely position detail, give it an inner scroll area or mount it after the entire member list.

The caller owns selection and supplies detail only to the selected occurrence. Exact native occurrence IDs are
independent of Subject IDs: repeated Subjects can have separate notes, facts and return anchors. Omit
`occurrenceId` for filtered projections without a native ID; a render key does not establish occurrence identity.
The caller also supplies the detail ID and expanded state for the Inspect disclosure.

Opening does not focus or scroll the detail. Keyboard activation retains the focused Inspect control, and the
next Tab reaches detail's Close control, followed by its supplied actions. Pointer activation keeps the browser's
ordinary focus behavior. The detail remains a named, focusable region without an outlined content card.
`onClose` lets Escape at an expanded opener close without moving focus. Close or unhandled Escape inside the
detail calls its close handler and returns focus to the captured opener with `preventScroll`.

Page, native observation, viewer, locale, layout or admission replacement retires selection. The caller retires
focus still owned by an obsolete opener; detail unmount never restores focus or scrolls. Pending and failed pages
cannot retain selected evidence from the preceding read. Clipboard outcomes belong to their mounted occurrence
and cannot update a replacement selection. There is no detail acquisition: the caller renders already supplied
facts, complete notes and exact reference copy/open actions, with permission and failure outcomes by the controls.
