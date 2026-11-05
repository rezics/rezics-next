# Account verification review

Management links to the pending review list. Each application opens its evidence and supported decisions inline,
so closing the evidence returns to the same page. Independent evidence links open their supplied HTTPS destinations.

Accepted decisions disable only their application so reviewers can continue the current list.
A recoverable failure retains the original application, action, reason and command key in this browser tab;
reconciliation replays that input before another decision is allowed. Feedback remains available during a failed
list refresh and after the application leaves the pending page. Late responses cannot update another viewer or
account scope. A restored draft grants no authority: current native authorization and completion remain decisive.

The transport and command contracts are unchanged. Approval acceptance is distinct from public verification.

Reviewer requests use the existing Web account ten-second deadline for headers and body decoding, composed with
caller cancellation. Queue account and subject labels resolve independently in parallel; failed labels remain
missing references without suppressing the authorized bounded page or changing its cursor. Discovery and page reads
also run independently. Account review bounds latest-request, identity, discovery, publication and governance reads;
failed publication is unknown and failed governance grants no control. Refresh retries the current cursor; First page
explicitly restarts it. Readback must finish before a saved decision can resume through current native authority.

Review-window coordinates use the released native list-cursor grammar: ASCII base64url tokens of at most 4,096
UTF-8 bytes. Retain at most eight prior accepted coordinates and one current coordinate (36,864 bytes); one staged
movement target may coexist with them during its read (40,960 bytes maximum). The retained history contains only
cursor coordinates, while the query cache replaces one bounded page per reviewer observation and locale. A direct
cursor has no inferred predecessor. Next admits one prior coordinate only after the replacement page is admitted;
Previous removes its target only after that target is admitted; First clears history only after the cursor-free page
is admitted. Refresh and Retry reread the current requested coordinate without changing the history.

Each initial, Next, Previous, First, Refresh or Retry action invokes one existing `readReviewPage` call. That call
runs one native discovery request and one pending-page request in parallel. A non-empty page retains the existing
label reads: at most one batched Accounts request and one subject request per returned row (at most 20); an empty
page adds no label requests. No history entry retains a page, row, evidence or decision draft.

Decision: allow 35 seconds for the page round trip (session plus two read phases) and 25 seconds for a command
(session plus dispatch); a deadline leaves the original command uncertain, with explicit same-input/key recovery only.
These observation deadlines also settle non-cooperative transports and release timers and abort listeners; late
responses cannot settle retired attempts. Existing unavailable, uncertain and refresh copy applies in all eight locales.
