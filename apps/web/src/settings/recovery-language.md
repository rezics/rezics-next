# Settings recovery language

This page records the placement and meaning of the closed, preparing, and unavailable messages used by Settings.
It describes reader-facing intent; the existing controls and destinations remain owned by their workflows.

## Shared Settings and preference availability

| Exact key                  | Consuming workflow                                                                         | Meaning and action                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| settings_closed_title      | Default Settings failure, the Reading panel, notification recovery, and section navigation | The Settings area is unavailable. The title avoids internal service or “closed” terminology.                                                                                     |
| settings_closed_text       | Default Settings failure, Reading recovery, and notification recovery                      | State that Settings are unavailable now without claiming a save failed. The existing contextual retry or reload control remains the recovery action.                             |
| settings_preparing_title   | Default Settings failure, Reading recovery, notification recovery, and section navigation  | The state really is preparation; retain the concise “being prepared” wording.                                                                                                    |
| settings_preparing_text    | Default Settings failure, Reading recovery, and notification recovery                      | The settings are not ready yet; retain the current short suggestion to try again shortly because that matches the preparation state.                                             |
| settings_unavailable_title | Default Settings failure, Reading and notification recovery, and section navigation        | The current settings could not be checked.                                                                                                                                       |
| settings_unavailable_text  | Default Settings failure, Reading and notification recovery                                | Say that the current settings could not be checked or confirmed. Do not imply that a write was lost; the existing workflow shows whether to reload or retry its exact operation. |

## Profile, privacy, avatar, verification, notifications, and Reading

| Exact key                          | Consuming workflow                                      | Meaning and action                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| settings_privacy_closed            | Collection visibility rows and Collection list recovery | Collection privacy settings are unavailable. Keep the message neutral about whether a change was saved; the row supplies the appropriate reload or retry control.             |
| settings_profile_avatar_closed     | Profile avatar upload                                   | Profile picture upload is unavailable; retry the upload later.                                                                                                                |
| settings_verification_read_closed  | Agent verification status read                          | The current verification status could not be loaded. Reload the status later; the copy makes no claim about a submitted request.                                              |
| settings_notifications_read_closed | Notification preference read and readback after a write | The current notification settings could not be loaded. Reload to check their current values; do not imply that a prior change was not saved.                                  |
| settings_profile_read_closed       | Profile and public activity current-profile read        | The current profile could not be loaded. Keep edits on the page and reload to inspect the current profile. A refused read does not establish whether a prior write was saved. |
| settings_profile_save_closed       | Profile save refusal                                    | Profile editing is unavailable. Keep the draft and reload the current profile before submitting a new save.                                                                   |
| settings_public_activity_closed    | Public activity visibility save refusal                 | Public activity settings cannot be changed right now. Keep the draft and reload the current profile before trying a new change.                                               |
| settings_reading_read_closed_title | Reading preference read and current-value readback      | Identify that the current Reading settings could not be loaded.                                                                                                               |
| settings_reading_read_closed_text  | Reading preference read and current-value readback      | Keep the draft and reload to check current values. If a write is unresolved, the separate existing message and control retain exact-retry guidance.                           |

The catalog values are localized in each locale. No help destination, disclosure, or recovery control was added or changed.
