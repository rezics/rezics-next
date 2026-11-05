# Work tag reading

Decision: apply the current spoiler preference before projecting tag rows, empty
state and pagination. Hidden associations contribute no placeholders or pages;
changing the existing reader preference restores the exact source assertions.
Labels never merge Concept identities. Disclosed associations retain their
statement, source weight, citation and qualification when navigating to Concepts.

- Touches: released work facet statements and their supplied related Concepts;
  no extra native reads or source acquisition.
- Bound: one pass over supplied facet statements, with pages of 12 disclosed
  associations. Source weights remain evidence on their original statements.
- Growth check: `apps/web/tests/work-tag-reading.test.tsx` compares one visible
  association with the same association preceded by 24 hidden associations;
  `apps/web/tests/subject-concept-tags.test.tsx` exercises mounted navigation and
  preference replacement.
