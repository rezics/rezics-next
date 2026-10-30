# Reporter status

The private report page reuses `ReporterStatusView`. It renders only the submitted reference/revision, reason,
evidence, times and the report disposition. Pending means a null native outcome. Actioned stays actioned after an
appeal. Available and unavailable are current annotations; neither creates a target link or another read.
The page performs one exact report GET with the current viewer credential, with private no-store responses.
A missing or unrelated report is not found. Service failures use retry without submitting another report.

Patterns/Reporter status uses the same presenter as Pages/Reporter status. Review the same IDs with phone390 and
desktop1280 viewport globals, locale and theme globals; no viewport or locale exports. Pattern IDs:
`patterns-reporter-status--pending`, `--actioned`, `--dismissed`, `--target-unavailable`, `--retry`.
Page ID: `pages-reporter-status--submitted-report`. Plays cover status/reference visibility, absence of target
links and keyboard retry. Fixtures follow the adopted wire shape; native acceptance and Root screenshots remain
pending under the minimal verification instruction. A story is not native authority evidence or visual approval.
