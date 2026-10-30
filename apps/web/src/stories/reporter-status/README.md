# Reporter status

The private report route reuses `ReporterStatusPage` and `ReporterStatusView`. The receipt leads with an explained
pending, actioned or dismissed disposition and a Submitted/Reviewed timeline using the native timestamps. Submitted
reason and evidence have separate readable sections. Pending means a null native outcome. Actioned stays actioned
after an appeal. Available and unavailable are current annotations; neither creates a target link or another read.
The unavailable item retains the reporter's evidence. Missing evidence is stated explicitly. IDs and any submitted
revision sit in expandable reference details, with native clipboard copying and an honest copy failure message.
The page offers the existing localized Inbox destination; the DTO supplies no authorized target destination.
The page performs one exact report GET with the current viewer credential, with private no-store responses.
A missing or unrelated report is not found. Service failures use retry without submitting another report.

Patterns/Reporter status uses the same presenter as Pages/Reporter status. Review the same IDs with phone390 and
desktop1280 viewport globals, locale and theme globals; no viewport or locale exports. Pattern IDs:
`patterns-reporter-status--pending`, `--actioned`, `--dismissed`, `--target-unavailable`, `--submitted-details`, `--native-error`, `--retry`.
Page ID: `pages-reporter-status--submitted-report`. It uses the actual route, shared site shell and existing
report-unavailable fixture rather than another page wrapper. Plays cover status/reference visibility, native
details opening, clipboard outcome, absence of target links and keyboard retry that remains failed on refusal.
Fixtures follow the adopted wire shape; native acceptance and Root screenshots remain
pending under the minimal verification instruction. A story is not native authority evidence or visual approval.
