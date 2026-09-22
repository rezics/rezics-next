# Realm rule authoring and localization

## Meaning and presentation

A rule has an exact approved semantic revision and separately identified localized
forms. Translation/editing provenance and status remain visible. Changing UI locale
does not change the rule a user accepted. Unknown/missing translation is explicit,
with the actual fallback language shown.

## Authoring workflow

Draft/edit -> compare -> review -> approve exact meaning -> activate. Localized
forms can cite the same meaning only after the elected review; material changes
create a new rule revision and re-evaluate required consent/review. Preserve
pending drafts and stale conflicts rather than overwriting another editor.

## Acceptance

Test independent localized edits, activated-rule changes during moderation,
missing/RTL language, consent generation and keyboard/accessibility. A display
translation never widens enforcement permissions or retroactively changes evidence.
