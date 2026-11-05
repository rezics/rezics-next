# Defensive programming in agent-written code: measurement, causes and countermeasures

Researcher: Claude Opus 5.5. Written 2026-11-04 (UTC). State: open.

This report answers whether GPT models' preference for defensive code is real in REZICS, what causes and amplifies
it here, what stops it, what happens to existing defensive code, and who keeps it from growing back. The rule it
serves is in [efficiency](../development/efficiency.md#daily-improvement): trust agents; a guard is kept only when its
measured catches outweigh its cost and no agent could repair the problem in place; money movement keeps its guards.

## Summary

1. **Line-level defensive code exists, but it is not GPT-specific.** Matched by area, GPT-6.1 Sol, GPT-6 Luna, Grok
   and Claude Sonnet 5.5 write about the same density of defensive lines. Blind labelling found 21% of such lines
   unjustified for each GPT model, 21% for Grok and 25% for Claude Sonnet. The surrounding file predicts the density
   of new code (r = 0.49); the engine does not. Unjustified defensive lines are about 1.3% of product lines.
2. **The cost sits in mechanisms, not lines.** These are guards that end attempts, and prompt or brief prohibitions
   that make capable workers stop. Since 2026-10-25, 10,280 attempt-hours ran. Endings by kind:
   - Rebase conflicts: 2,260 endings, 1,211 h. A fix is in flight.
   - Spec-conflict stops: 1,179 endings, 1,331 h. In a 40-stop sample, 31 were caused by a prohibition (frozen
     test, "do not edit", "do not invent"), where the repairing edit was obvious.
   - Scope fences: 461 endings, 409 h.
   - Stall, round, proof-repetition and repeated-assertion limits: 1,032 endings, about 860 h.
3. **Our process creates the control-plane refusals, not the GPT prior.** Of 15 control-plane refusal or stop paths
   with a traceable origin, 12 were specified in briefs or commits authored by Claude, and 3 by GPT managers. Of the
   12, 11 came from the Claude supermanager, 1 from a Claude-engine manager, and 6 came from the initial port of the
   legacy control plane. GPT workers implemented nearly all of them, as they implement nearly all code.

   The founding case is commit `44db6f3354`. A supermanager brief specified that refusal after one incident, and the
   GPT worker built exactly what the brief asked. The generator is the incident method in `efficiency.md`, which says
   "a control-plane change, a gate or a brief rule must prevent recurrence", together with brief writers who follow it.

4. **The countermeasure works where briefs are written, not where code is written.** On GPT-6.1 Sol, a trust-model
   block in the worker prompt changed nothing measurable on two real briefs. It did not override a brief that
   demanded a refusal, even when it explicitly told the worker to.

   The same idea in the manager prompt flipped the design. Given the original incident, the baseline manager briefed
   "reject ambiguous edits atomically". The manager with the trust block briefed agent resolution through
   `train-resolver.ts` "without new internal refusal gates". That is the fix now in flight. This is one run per arm:
   indicative, not proven.

5. **Recommendation, in order:**
   1. Remove the prompt-level stop triggers: frozen files and the broad spec-conflict blocker.
   2. Put the trust model into the manager and supermanager role text, the incident method, the verification rules
      and brief preflight.
   3. Register every attempt-ending path in a typed guard ledger that the hourly report prices, and convert the
      zero-information refusals into in-place repair.

   The efficiency owner owns the ledger and its weekly ratchet. Product-code cleanup goes through ordinary Goal briefs
   from a weekly report, not through a landing gate. Expected saving: roughly 60–125 attempt-hours a day on current
   volume, excluding the rebase fix already in flight.

## Data and window

- **Store.** `.temp/goal/goal.sqlite`, read-only. Window 2026-10-25 00:20 UTC (store start after the rewrite reset)
  to 2026-11-04 21:40 UTC: 10.9 days, which is the whole available part of the 14-day window. 13,663 attempts and
  10,280 attempt-hours ended in it.
- **Attribution.**
  - Each passed `gate-outcome` carries `mergedCommit`; there are 6,461 passed landings.
  - Dev and main are linear on the first parent. A landing's code is the diff from the previous landing's merged
    commit to its own, restricted to its `nonGeneratedChangedFiles`.
  - The model is the landing attempt's `profile`. Batched landings that share one merged commit are attributed to
    their first task. This drops a few percent.
  - Origins of control-plane code: `git log -S` on main and dev, mapped to the landing range or to commit trailers.
- **"Next-attempt hours"** is the wall time of the attempt after an ending. It is an upper bound on loss, because
  superseded attempts often keep their work. **"Rewritten"** means a new brief file `<id>-<n+1>.md` existed for the
  next attempt. A stop followed by an unchanged brief carried no new information to the contract.
- **Scripts.** The read-only scripts used here are not kept in the tree; the definitions below reproduce them.

## 1. Measurement

### 1.1 Definition of a defensive construct

Lexical detector. A defensive line is an added, non-blank, non-comment line of product (non-test, non-generated)
TypeScript that matches any of these:

| Category                     | Pattern                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| throw                        | `\bthrow\b`                                                                                                                            |
| runtime type check           | `typeof x ===`/`!==`, `Array.isArray(`, `Number.is{Finite,Integer,SafeInteger,NaN}(`, `instanceof`                                     |
| nullish check                | `=== undefined`, `!== null`, `== null` and similar                                                                                     |
| catch                        | `\bcatch\b` (try/catch and `.catch(`)                                                                                                  |
| assertion or validation call | `assert*(`, `invariant(`, `ensure*(`, `validate*(`, `verify*(`, `guard*(`, `require*(`, `reject*(`, `refuse*(`                         |
| refusal vocabulary           | `refus`, `reject`, `forbid`, `fail closed`, `malformed`, `not allowed`, `must not`, `disallow`, `unsupported`, `invalid`, `unexpected` |

The detector counts candidates; it cannot tell a needed check from a redundant one. Each candidate therefore gets one
of seven labels:

- **B**: boundary validation that is needed: HTTP input or response, an imported record, an external file,
  environment or configuration value, or a third-party API.
- **D**: a domain or authorization rule.
- **N**: not defensive.
- **R**: redundant; types, upstream validation or the caller's contract already exclude the case.
- **I**: internal distrust; it validates the repository's own data, module output or agent output.
- **F**: fallback or catch-and-continue that masks a defect.
- **X**: a refusal where repair would do.

**Unjustified** = I + R + F + X.

Tests that pin guards: the share of test titles (`it(`/`test(`) containing refusal or negative words. These include
reject, refuse, throw, fail, invalid, deny, never, does not, cannot, unknown, missing, stale and foreign.

### 1.2 Prevalence by engine, model and area

Defensive lines per 1,000 added product lines, landed since 2026-10-25. `packages/client` is excluded because it is
generated.

| Area                |  GPT (Sol + Luna) | Grok 4.6/4.7 | Claude Sonnet 5.5 |
| ------------------- | ----------------: | -----------: | ----------------: |
| `apps/web`          | 43.4 (420k lines) |   40.5 (62k) |        41.3 (11k) |
| `services/kernel`   |       75.1 (382k) |   88.8 (15k) |         73.3 (4k) |
| `services/importer` |        76.8 (22k) |   91.0 (31k) |                 — |
| `tools/goal`        |        72.0 (34k) |    89.3 (3k) |                 — |
| `packages/ui`       |        17.9 (17k) |            — |         8.6 (10k) |

The same six code areas (kernel, web, importer, `tools/goal`, auth, scripts) pooled by model and effort:

| Model / effort           | Defensive per 1k | throw per 1k | Negative test titles |
| ------------------------ | ---------------: | -----------: | -------------------: |
| Claude Sonnet 5.5 / high |             53.1 |         13.2 |                  26% |
| Cursor Grok 4.6 / high   |             52.2 |         11.2 |                  36% |
| Grok 4.6 / high          |             60.2 |         15.1 |                  40% |
| Grok 4.7 / high          |             92.8 |         34.2 |                  24% |
| GPT-6 Luna / max         |             66.0 |         18.8 |                  29% |
| GPT-6 Luna / high        |             66.7 |         27.3 |                  30% |
| GPT-6.1 Sol / high       |             63.5 |         24.5 |                  38% |
| GPT-6.1 Sol / xhigh      |             41.1 |          7.2 |                  41% |

The effort rows mix areas differently: xhigh carried more web work. They do not isolate an effort effect.

Within an area the engines differ by less than the areas differ from each other.

Density rises with the attempt number (GPT: 56.7 on attempt 1, 62.4 on attempt 2, 67.4 on attempt 3 or later;
throws 16.4, 20.1, 25.7). This fits incident-driven additions on retries, but area mix is not controlled here.

**Blind classification.** 96 candidate lines were sampled, 24 per family, from the kernel, web, importer,
`tools/goal`, auth and scripts. They were shuffled, stripped of authorship and labelled by a separate agent with type
lookups.

| Family            |   N |   B |   D |   I |   R |   F |   X | Unjustified |
| ----------------- | --: | --: | --: | --: | --: | --: | --: | ----------: |
| GPT-6.1 Sol       |  10 |   6 |   3 |   3 |   0 |   2 |   0 |         21% |
| GPT-6 Luna        |  14 |   3 |   2 |   3 |   1 |   1 |   0 |         21% |
| Grok              |  12 |   5 |   2 |   3 |   1 |   1 |   0 |         21% |
| Claude Sonnet 5.5 |  14 |   2 |   2 |   4 |   1 |   1 |   0 |         25% |

With n = 24 a family, the 95% interval on each share is about ±17 points, so no engine difference is detectable.
Typical unjustified lines include:

- an effect re-validating the kernel's own outbox event;
- a store re-checking uniqueness of members it planned itself;
- the web re-checking hit invariants the kernel guarantees;
- an empty catch around a refetch;
- a host-file read falling back to local placement.

**Whole tree.** The current dev tree has 981k product lines at 58.0 defensive lines per 1k; `legacy-final` has 576k
lines at 66.3.

| Area          |                    Dev |    Legacy equivalent |
| ------------- | ---------------------: | -------------------: |
| Backend       | `services/kernel` 69.2 | `services/main` 94.7 |
| Web           |        `apps/web` 42.5 |      `apps/web` 32.3 |
| Control plane |      `tools/goal` 68.3 |  `scripts/goal` 78.0 |

At about 22% unjustified, dev holds roughly 13 unjustified defensive lines per 1,000 product lines, about 12,000
lines in total.

**House style.** Across 404 file-and-commit pairs, the defensive density of the existing file predicts that of the
lines added to it: Pearson r = 0.49 (web 0.58, kernel 0.36, `tools/goal` 0.21).

| Existing file density | New lines' density |
| --------------------- | -----------------: |
| 1.3% (low tertile)    |               3.0% |
| 5.0% (middle tertile) |               4.2% |
| 11.5% (high tertile)  |               9.7% |

Defensive code reproduces itself through the context agents read.

### 1.3 Brief register

Brief files (original version, `briefs/<id>.md`) by author. Since 2026-10-29 every Goal manager runs on Codex GPT;
the supermanager is Claude Opus 5.5. "Adversarial" means the brief contains forged, foreign, tamper, hostile, replay,
spoof, malicious or adversarial.

| Author                              | Briefs | Prohibitions per 100 words | Defensive vocabulary per 100 words | Adversarial | Refusal wording |
| ----------------------------------- | -----: | -------------------------: | ---------------------------------: | ----------: | --------------: |
| Goal managers, from 10-29 (GPT)     |  4,702 |                       3.01 |                               1.73 |         41% |             44% |
| Goal managers, before 10-29 (mixed) |  2,364 |                       2.69 |                               1.31 |         44% |             45% |
| Supermanager, from 10-29            |     43 |                       1.54 |                               0.95 |          0% |             16% |
| Supermanager, before 10-29          |    107 |                       1.51 |                               1.04 |          2% |             30% |

GPT managers write in a markedly more defensive register. Domain confounds this: the Goal managers own Access,
accounts and commerce, while the supermanager briefs mostly control-plane work. The switch to all-GPT managers
coincided with +32% defensive vocabulary but no change in adversarial framing.

The brief register does not predict line-level density in the landed code. Kernel density by brief-vocabulary
quartile was 75.0, 74.9, 74.3 and 75.9; web was 42.6 to 47.9. The register shapes which mechanisms get built
(custody records, fences, replay refusals), not how individual lines are written.

### 1.4 Control-plane guards: inventory, origin, firings and cost

The window is 2026-10-25 to 2026-11-04 (10.9 days). In the table:

- Firings counts the attempt endings or gate refusals.
- Own hours counts the hours of the attempts that ended.
- Next hours counts the hours of the attempt after each ending.
- Rewritten gives the share of next attempts that ran on a changed brief.
- Next / ever landed gives the share of tasks whose next attempt landed, and the share of tasks that landed at all.

| Guard (where)                                                     | Origin                                                          | Specified by → built by                  |        Firings | Own h | Next h | Rewritten | Next / ever landed |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- | -------------: | ----: | -----: | --------: | -----------------: |
| Rebase "could not apply" ends the attempt (merge-train)           | mechanical, pre-rewrite                                         | —                                        |          1,657 | 1,126 |    606 |        3% |          45% / 79% |
| Union keeps task-deleted lines → refusal (merge-train)            | `44db6f3354`, 10-30, after one incident                         | supermanager brief → Sol                 |            116 |   104 |     48 |        0% |          48% / 80% |
| Control-plane proof interrupted three times                       | `88bcc05cac`, 11-01                                             | control-plane manager (GPT) → Sol        |            121 |   107 |     70 |        0% |          18% / 48% |
| Typecheck failed at landing                                       | gate                                                            | —                                        |            115 |    77 |     55 |       37% |          49% / 95% |
| Affected tests introduced failures                                | `07fec0306e`, 10-28 port                                        | supermanager                             |             71 |    16 |     56 |        1% |          14% / 37% |
| Ignored paths in the candidate                                    | setup                                                           | —                                        |             64 |    17 |     14 |        0% |          34% / 55% |
| Outside declared paths (gate, control-plane lane)                 | `outsideScopePaths`, `b73f08a340`, 11-03                        | control-plane manager → Sol              |             48 |    88 |    122 |        2% |           2% / 12% |
| Outside declared paths (scope stage)                              | 10-25 legacy port                                               | supermanager brief → Luna                |             45 |    15 |     11 |       93% |         69% / 100% |
| Change had no effect on dev → refusal                             | `3992ebe934`, 10-30                                             | supermanager brief → Luna                |             45 |    23 |     41 |        0% |          47% / 84% |
| Frozen acceptance file changed → refusal                          | `refuseFrozenAcceptanceChange`; prompt line `9f348386f1`, 10-26 | supermanager                             |            149 |     — |      — |         — |                  — |
| No committed changes beyond base → refusal                        | `343c2d59da`, 10-25, after one incident                         | supermanager commit                      | 65 since 10-29 |     — |      — |         — |                  — |
| Claim source dirty at settlement                                  | `a31a829b12`, 11-03                                             | control-plane manager → Sol              | 97 since 10-29 |     — |      — |         — |                  — |
| Failed to regenerate derived files                                | gate                                                            | —                                        | 87 since 10-29 |     — |      — |         — |                  — |
| `spec-conflict` worker stop (prompt blocker rule, frozen line)    | prompt; wording `010f2c1405`, 11-02                             | supermanager                             |          1,179 | 1,331 |    915 |       39% |          34% / 84% |
| `stalled` (no commit within step/time limit)                      | 10-25 legacy port                                               | supermanager brief → Luna                |            776 |   613 |    513 |       22% |          27% / 80% |
| `scope-growth` (non-dev lanes: paths or estimate over 2×)         | 10-25 port; tolerance `5cb574a8b6`                              | supermanager and a Claude manager → Luna |            461 |   409 |    241 |       54% |          42% / 83% |
| `round-limit` (fix round ≥ 2, non-dev lanes)                      | 10-25 legacy port                                               | supermanager brief → Luna                |             75 |   136 |     54 |        8% |          17% / 32% |
| `repeated-assertion`                                              | 10-25 legacy port                                               | supermanager brief → Luna                |             60 |     4 |     32 |        0% |          10% / 57% |
| `early-stop` (worker said success, gate failed)                   | 10-25 legacy port                                               | supermanager brief → Luna                |            521 |   269 |    315 |        0% |          26% / 81% |
| Check tooling refuses its host environment (inside `environment`) | check-run and web-check entrypoints                             | performance Goal (GPT)                   |           ≥231 |   ≥84 |      — |         — |                  — |

Three rows marked "since 10-29" use the counts from the research brief's own table; I did not re-derive their
follow-up columns.

Gaps in this inventory:

- **Environment endings.** There were 2,330 since 10-25. Only 422 carry classifiable text. Of those, 231 are our own
  check tooling refusing work, for example:
  - "unsupported host-path environment setting DEBUGINFOD_IMA_CERT_PATH";
  - "host-absolute environment dependency EDITOR is unsupported";
  - "custody remains occupied";
  - "the trusted Performance checkout must be clean".

  The other 191 are real outages (SSH, Docker timeouts, SSL). The remaining 1,908 endings (1,182 h) store no
  classifiable text.

- **Not measured** for lack of a firing record in the window: inbox caps, `turnsWithoutDecision`, owner-contract
  decisions (582 accepted events), proof and custody ceremonies outside the rows above, and brief rewriting.

Reading the inventory against the rule ("kept only when catches outweigh cost and no agent could repair it in
place"):

- **Rewritten at 0–3%.** Rebase, union deletions, proof interrupted, ignored paths, no effect, early stop and
  repeated assertion were followed by an unchanged brief at least 97% of the time. The stop carried no information
  that a person or manager needed. Each is repairable in place.
- **Rewritten at 54% or 93%.** The scope fences are followed by a rewrite, but the rewrite's content is "widen the
  paths". The fence buys a manager round-trip and nothing else.
- **Low ever-landed.** Outside declared paths at the control-plane gate (12%), round limit (32%) and proof
  interrupted (48%) kill tasks outright. The catch rate cannot be judged from rewrites. These guards end work that
  is never finished, which is the worst outcome under the rule.
- **Real catches.** Typecheck (37% rewritten, 95% eventually landed) and affected-tests failures find real defects.
  They are still repairable by the same worker in the same session.

### 1.5 Prompt-level prohibitions: the spec-conflict sample

I sampled 40 of the 666 spec-conflict stops since 2026-10-29. Sol wrote 515 of the 666 stops and Luna wrote 150.

| Cause                                                                                                                                                                                                   | Count |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| A frozen or preserved acceptance test contradicts the contract, an owner document or delivered code, and the worker is forbidden to edit it                                                             |    18 |
| The brief forbids the edit, the seam or the scope the fix needs ("forbids editing", "inventing a method would violate the contract", "requires reporting the missing seek instead of building another") |     7 |
| The brief forbids building a missing dependency, which agent conduct says to build as a minimal seam                                                                                                    |     4 |
| Another prohibition-driven test or fixture mismatch                                                                                                                                                     |     2 |
| A genuine product or ownership decision                                                                                                                                                                 |     4 |
| A base failure, which is not a blocker under the prompt's own rule                                                                                                                                      |     1 |
| Research needed                                                                                                                                                                                         |     1 |
| Unfinished work misfiled as a stop                                                                                                                                                                      |     1 |
| Empty                                                                                                                                                                                                   |     2 |

In 31 of the 40 stops (78%, 95% interval about 62–89%), the conflict was created by a prohibition, and the repairing
edit was evident from the blocker text itself.

One stop quotes a control-plane guard directly. "No committed changes beyond the base" contradicts the prompt's own
instruction to report success when the behaviour already exists.

Cost per stop, from the logs of these 40 attempts:

- mean 13.8M input tokens, 98% cached (median 4.5M);
- 66k output tokens;
- the stopped attempt plus a manager rewrite only 39% of the time.

### 1.6 Hypotheses

Confidence is 0–100.

**H1: GPT-authored code has measurably more defensive constructs than other engines' code, and the control plane's
refusal paths were mostly GPT-authored after single incidents. Confidence 15.**

- Not supported at line level. Per-area density is similar, and the unjustified share is 21% for GPT, 21% for Grok
  and 25% for Claude Sonnet.
- The control-plane refusals were built by GPT workers, but the briefs or commits that specified them were mostly
  Claude-authored (12 of 15 traced).
- The two refusals confirmed to come from a single incident were specified by the Claude supermanager.
  - Union deletions: one accounts incident.
  - "No committed changes": one staged-but-uncommitted worker.
- GPT managers do write more defensive briefs (§1.3).

**H2: Our instructions and review loops amplify the tendency more than the model prior does. Confidence 75.**

Supported for instructions and process:

- the incident method requires "a control-plane change, a gate or a brief rule";
- prohibitions cause 78% of spec-conflict stops;
- the opening rule of `verification.md` demands invalid, hidden, replay and dependency-failure acceptance on every API;
- the check-tooling documents prescribe "fail closed" and refusals of "foreign" input against our own hosts;
- the manager experiment (§3.1).

Review rounds asking for hardening: no evidence. No reviewer path in `tools/goal` asks for it, "harden" appears in
57 of 11,537 brief files, and fix rounds are 6% of attempts.

**H3: An explicit trust model in the role prompt substantially cuts defensive constructs on GPT-6.1 Sol, without
raising escaped defects.**

- In the worker prompt: confidence 20. No measurable cut on two real briefs, and it does not override a brief's
  demanded refusal.
- In the manager prompt: confidence 65. One run flipped from refusal to repair.
- No escaped defect in the one oracle that could measure it.

**H4: Instructions alone decay; a static ratchet plus a guard-pricing review is needed. Confidence 55. Partly
supported, with a correction.**

- No decay data yet: the rule is one day old.
- The ratchet that matters is on guard cost (ledger hours), not on lexical counts. A count ratchet on product code
  would target about 1.3% of lines, and as a landing gate it would itself be a guard against agents.

**H5: Prompt-level prohibitions cost more than code guards. Confidence 60. Partly supported.**

- Prohibition-driven stops cost about 0.78 × 1,331 ≈ 1,040 attempt-hours.
- The largest single code guard, rebase conflicts, costs 1,211 h.
- Prohibitions are the largest class not already being fixed, and they make capable agents stop, exactly as H5
  predicts.

**H6 (added): Defensive code begets defensive code through context. Confidence 70.** r = 0.49 between existing and
new density.

**H7 (added): The incident method is the main generator of control-plane guards, regardless of model. Confidence 70.** Origins in §1.4 and the manager experiment.

**H8 (added): Part of the `environment` loss is our own fail-closed check tooling. Confidence 60.** 231 of the 422
classifiable endings; 82% of environment endings are unclassifiable.

## 2. Causes in our setup, ranked by evidence

1. **The incident method turns each incident into a gate.** `efficiency.md`, Incident method: "a control-plane
   change, a gate or a brief rule must prevent recurrence".
   - Brief writers of both engines apply it literally.
   - The founding case (`44db6f3354`) and "no committed changes" (`343c2d59da`) were single-incident refusals.
   - Evidence: guard origins, and the manager experiment.
2. **Prohibitions in briefs and prompts turn mismatches into stops.** These are the frozen-file line ("must not be
   edited"), the prompt's spec-conflict blocker, and brief clauses such as "do not invent" or "do not edit".
   - 1,179 stops, 1,331 h.
   - 78% of the sampled stops were prohibition-driven.
   - 149 further landing refusals for frozen-file edits.
3. **Owner documents prescribe refusal behaviour.**
   - `verification.md` opens with acceptance that covers "invalid and hidden resources, lifecycle changes, replay and
     dependency unavailability" for every API.
   - The check-tooling documents (`web-check-entrypoints.md`, `remote-check-input-custody.md`,
     `check-host-recognition.md`, `compiler-check-placement.md`) specify "fail closed", "defense in depth" and
     refusal of "foreign" or "malformed" evidence produced by our own processes.
   - Workers read these documents and reproduce them. Evidence: document text, the environment refusals, and density
     in `scripts/` (87 per 1k, the highest area).
4. **The brief register of Goal managers.**
   - 41% of briefs carry adversarial framing, against 0–2% for the supermanager.
   - Defensive vocabulary is 1.8 times the supermanager's.
   - It shapes which mechanisms are built (custody, fences, replay refusals).
   - Moderate evidence, confounded by domain.
5. **House style.** Existing defensive code is copied into new code (r = 0.49). Strong for line-level density, but
   the stakes are small.
6. **Model prior.** Not detectable at line level against Grok and Claude Sonnet in this repository. The single
   strongest qualitative trait of GPT-6.1 Sol in the experiments is literal compliance with the brief, including its
   refusals. The prior matters through the brief writer more than through the code writer.
7. **Reasoning effort and routing.** Inconclusive: the effort rows are area-confounded. No change is warranted on
   this evidence.
8. **Hardening requests in review rounds.** No evidence in this setup.

## 3. Countermeasures

### 3.1 Experiments

Six Codex runs on `gpt-6.1-sol`, effort high, Standard tier, in throwaway worktrees at each task's original dev base
commit. Nothing was pushed or landed, and the worktrees were removed afterwards.

- **Worker baseline.** The current `launch.ts` worker template under minimal verification.
- **Worker treatment.** The baseline plus one trust block of 1,215 bytes:
  - validate only at boundaries;
  - trust callers and agents;
  - prefer repair to refusal, even when the contract asks for a refusal that could be repaired in place;
  - no fallbacks for impossible cases;
  - a guard only for a defect shown with a concrete input;
  - money keeps strict validation.
- **Manager arms.** The current manager opening plus an incident, with and without the manager trust block given in
  §3.2.

Two real briefs were used:

- **Brief A** (Definitions: structural bases and ordered facets) is a clean library brief with legitimate boundary
  refusals.
- **Brief B** (union deletions) is the brief behind `44db6f3354`. It demands a refusal.

Defensive lines were counted by the §1.1 detector over the arm's diff, then labelled as requested by the brief or not.

| Run              | Prompt           | Product lines | Defensive lines |                    Unrequested | Test lines | Landed acceptance replayed |    Time | Input / output tokens |
| ---------------- | ---------------- | ------------: | --------------: | -----------------------------: | ---------: | -------------------------- | ------: | --------------------: |
| A worker         | baseline         |            73 |               8 |                              0 |        164 | 3/3 pass                   | 4.6 min |          0.89M / 9.5k |
| A worker         | + trust          |            74 |               8 |                              0 |        128 | 3/3 pass                   | 5.1 min |         0.96M / 10.6k |
| B worker         | baseline         |            53 |               9 | 0 (built the demanded refusal) |        103 | 1/2 (log wording differs)  | 3.3 min |          0.52M / 7.0k |
| B worker         | + trust          |            49 |               6 |    0 (still built the refusal) |         94 | 1/2 (same)                 | 5.1 min |         1.06M / 10.3k |
| Incident → brief | manager baseline |             — |               — |                              — |          — | —                          | 2.9 min |          0.49M / 4.3k |
| Incident → brief | manager + trust  |             — |               — |                              — |          — | —                          | 3.2 min |          0.53M / 4.2k |

The historical landings of the same briefs had 112 product lines and 10 defensive lines (Luna, brief A) and 53 and 8
(Sol, brief B).

What the two manager runs briefed:

- **Baseline:** "Keep safe Markdown insertions and JSON three-way merging; reject ambiguous edits atomically."
- **With the trust block:** "Replace blind Markdown union and deletion-line rejection with resolution that applies
  the task's intended change … use agent assistance for semantic overlaps, then continue integration. Reuse
  `train-resolver.ts` … cover those outcomes without new internal refusal gates." It also listed the refusal tests
  whose expectations "yield to successful resolution".

Findings:

- GPT-6.1 Sol did not over-guard either brief. Every defensive line was requested by the brief or sits at a boundary
  (Git process errors).
- The worker trust block had no measurable effect.
- The worker built the refusal its brief demanded, even though its prompt told it to implement the repair.
- At the manager layer the same idea changed the design from refusal to repair.

Limits: one run per arm, two briefs and one incident. Treat the results as indicative. What would settle them: at
least five runs per arm on three incidents and three product briefs, with blind labelling.

### 3.2 Instruction text

**Manager template and supermanager role text.** This is the tested text, verbatim, 848 bytes. Add it to
`tools/goal/prompts/manager.md`, which uses 1,022 of its 5,000 bytes, and to the supermanager's session-start role
text:

> Trust model for briefs. Agents and internal callers are trusted; REZICS is a community product, and a mistake on
> dev is caught and returned after integration. When an incident shows a wrong result, brief the repair that produces
> the right result where the problem appears (resolve, merge, regenerate, normalize), so the pipeline continues. Do
> not brief a new refusal, rejection, stop or failed attempt unless no agent could produce the correct result there;
> if you still need one, state the defect it prevents and the attempts and hours it will cost. Ask for validation only
> at system boundaries: HTTP input, imported records, external files and third-party responses. Acceptance covers the
> behaviour asked for; ask for refusal tests only for boundary input and authorization rules. Money movement
> (payments, payouts, balances) keeps strict guards.

**Worker template** (`tools/goal/prompts/worker.md`, which uses 2,315 of its 3,500 bytes):

- **Replace the frozen-file line.** Current text: "Frozen acceptance files are already committed and must not be
  edited". New text:
  > Frozen acceptance files hold the contract's tests: {files}. If one contradicts the contract, an owner document or
  > the delivered code it depends on, change the smallest assertion that makes them agree, list the file and the
  > reason in your summary, and continue.
- **Replace the blocker sentence's opening.** Current text: "A blocker is only two requirements … that cannot both
  hold". New text:
  > When two requirements conflict, take the reading most consistent with the owner documents and the delivered
  > code, change the smaller side (a test, fixture or brief detail), list it and continue. A blocker is only a
  > conflict where every choice breaks an owner-document rule (quote both), or a tool or infrastructure failure …
- **Add the compact trust model**, 515 bytes. Its benefit is not proven by §3.1; it is cheap and states the
  boundary rule once:
  > Validate only where outside input enters: HTTP requests, imported records, external files and third-party
  > responses. Inside the repository, trust types, callers, other modules and agents; do not re-check what they
  > guarantee. When the correct result can be determined, produce it and continue instead of refusing or failing.
  > Let unexpected errors throw; add no fallback or catch-and-continue for cases that cannot happen. Add a guard only
  > for a defect you can show with a concrete input, and name it in your summary.

**Minimal-verification condition** (`tools/goal/prompts/conditions/minimal-verification.md`). Keep the deferral. It
is verification after integration, which the rule favours. Replace the prohibition and the override clause with a
permission:

> Acceptance, native, browser and root checks run after integration; you need not run them. Run a focused check
> yourself only when you cannot finish the outcome without seeing it, for example a page you changed.

**Owner documents:**

- **`efficiency.md`, Incident method, second paragraph.** Replace "Repair each class in tools or workflow: a
  control-plane change, a gate or a brief rule must prevent recurrence beyond the individual task" with:
  > Repair each class where it appears: give the problem to an agent at that point (resolver, same-session fix,
  > regeneration) so the pipeline continues. Add a check that refuses or ends work only when no agent can repair the
  > problem in place; register it in the guard ledger with the defect it prevents, and price it from its first
  > firing.
- **`verification.md`, opening paragraph.** Replace with:
  > API acceptance covers the personas and permission rules the outcome changes, through the real boundary. Test
  > rejection of invalid input where outside input enters, and lifecycle, replay or dependency failure only where
  > the outcome promises behaviour for them. Use native Access and production contracts. A permissive stub cannot
  > prove authorization or disclosure.
- **`agent-conduct.md`, Briefs.** Add:

  > Price every guard: a requirement that refuses, rejects, stops or fails work names the defect it prevents, where
  > untrusted input enters, and why no agent could repair it in place. Without that, brief the repair.

  Also add to the brief preflight in `delivery.md`: "Frozen files are only for cross-Goal contract cases".

- **Check-tooling documents** (`web-check-entrypoints.md`, `remote-check-input-custody.md`,
  `check-host-recognition.md`, `compiler-check-placement.md`). Their fail-closed rules are the specification behind
  the environment refusals. They belong to the performance Goal's quality pass in §6, change 4.

### 3.3 Static check

**Guard ledger (control plane).** This is the check that pays.

- `tools/goal/src/guards.ts` exports `GUARDS: Record<GuardId, { defect; owner; since; repair }>`.
- Every gate refusal sets a typed `refusal.kind: GuardId`; today the reason is a free string in `firstFailure`.
- Every attempt-ending `FailureClass` maps to a `GuardId`.
- A missing entry is a TypeScript error, not a grep. Agents repair it in place by adding the row with its price.
- The hourly flow report groups attempt endings by `GuardId`, with firings, attempt-hours, next-attempt hours,
  tokens, rewritten share and landed share.
- The ratchet is on cost: weekly guard-hours must not rise. Any guard with at least 20 firings and under 10% rewritten
  over 7 days is reported "repairable in place" and briefed for conversion.

**Product code.** An advisory weekly report, never a landing gate:

- the §1.1 density per area;
- empty or default-returning catch blocks (F), which are statically detectable;
- redundant conditions (R), via type-aware lint. `oxlint` 1.89 in the repository supports `--type-aware`. Whether it
  ships `typescript/no-unnecessary-condition` must be checked by the implementing worker; if not, run the TypeScript
  checker on a narrowing script.

The output is the 20 files with the most F and R findings, sent to their Goal managers as deletion candidates. This
also removes the examples that new code copies (§1.2, house style).

A landing gate on these counts is not recommended. It would fail agent work over about 1.3% of lines, which is the
pattern this report measures as costly.

### 3.4 Review step: price the guard

- **At brief time.** The manager self-checks against the agent-conduct rule above. The supermanager or efficiency
  owner reviews only briefs that add a `GuardId`, in one message: accept, or "brief the repair".
- **Daily.** The efficiency audit reads the ledger and converts guards with low catches and high cost.
- **Not recommended:** a per-landing simplification review by another model. It costs a review on every landing to
  find about 13 lines in 1,000, while the expensive defensiveness lives in briefs and the control plane. A periodic
  simplification brief per Goal, from the weekly report, gets the same deletions at a fraction of the cost.

### 3.5 Routing

- **No change to product workers on defensiveness grounds.** The engines are indistinguishable at line level here.
- **No engine change for brief writers.** The Claude supermanager specified most control-plane refusals. The rule
  and the role text are the lever, not the model.
- **Keep GPT-6.1 Sol** for control-plane implementation. It builds exactly what the brief says, which is the property
  that makes brief-level controls effective.

### 3.6 Vendor guidance and practitioner reports retrieved

These are background only. No current primary guidance on defensive code for GPT-6.1 Sol was retrievable.

- **OpenAI GPT-6 model guide**
  ([link](https://openai.com/index/practical-guide-building-gpt-6/)): the fetch returned HTTP 403, so it was not read.
- **OpenAI Codex prompting guide**
  ([link](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide), undated, names
  `gpt-5.3-codex`; retrieved 2026-11-04). It recommends "No broad catches or silent defaults" and "Bias to action:
  default to implementing with reasonable assumptions; do not end your turn with clarifications unless truly blocked".
  It predates the GPT-6 family, so it is background only.
- **Anthropic, Prompting Claude Opus 5**
  ([link](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5), undated;
  retrieved 2026-11-04). It says "Positive examples of the communication style you want tend to be more effective
  than instructions about what not to do", and it recommends removing explicit verification instructions because
  they cause over-verification. It has no Opus 5.5 section and no passage on defensive code.
- **Third-party reports, unverified.** These claim that OpenAI Codex staff, in September 2026, called over-specified
  and defensive AGENTS.md rules harmful to GPT-6 models
  ([summary](https://proflead.dev/posts/gpt-6-astra-codex-prompts-skills-agents-md/)). I could not find the original
  post.

The decisions in this report rest on our own measurements and experiments.

## 4. Verdicts on existing defensive code

The expected saving is "next-attempt hours per day", an upper bound. The figure after the slash assumes half of that
time was real loss.

**Delete or convert to in-place agent repair:**

- **Rebase conflict ending, and union-deletion refusal.** Convert to agent resolution; this is already in flight.
  Saving 56 h/day upper bound for rebase conflicts (606 h over 10.9 days), plus 4 h/day for the union refusal.
- **Spec-conflict stops caused by frozen files and brief prohibitions.**
  - Convert: the worker updates the contradicting test or builds the seam, and lists it (§3.2).
  - Saving about 65 h / 33 h per day (0.78 × 915 h ÷ 10.9), plus about 460 manager rewrite turns.
  - Delete the landing refusal of frozen-file edits in the dev lane (149 refusals). Record an edited frozen file in
    the landing log and send its owner an info message.
- **Scope fences on non-dev lanes.** This covers outside declared paths at the control-plane gate, the scope stage
  and the estimate overrun inside `scope-growth`.
  - Delete them. Use the dev-lane rule: list the outside-path files, and keep only undeclared risk-area files closed.
  - Saving about 22 h / 11 h per day (next-attempt hours of `scope-growth`, which already includes both fences),
    plus the manager rewrite each fence forces (93% and 54% rewritten). It also recovers the tasks killed at 12% ever
    landed.
- **Round limit (fix round ≥ 2), "proof interrupted three times" and repeated assertion on non-dev lanes.**
  - Convert: continue the same session with the failure, as dev product work already does without a limit. A task
    that fails three times goes to the third-attempt investigation, not to an automatic stop.
  - This changes `efficiency.md`, which today keeps "the controller's retry limits" for control-plane, stabilize
    and verification work.
  - Saving about 14 h / 7 h per day, plus the 52–68% of affected tasks that never landed.
- **"Change had no effect on dev", "No committed changes beyond the base", ignored paths, "claim source dirty at
  settlement" and "failed to regenerate derived files".**
  - Convert each: integrate a no-effect change as already present; commit staged work, which the controller already
    does in one path; drop or force-add ignored paths; clean generated dirt; regenerate with an agent.
  - Saving about 5 h / 3 h per day for the two rows with follow-up data (no effect, ignored paths). The other three
    are measured only by count, which is similar.
- **Stall detection (`stalled`).** Convert from ending the attempt to resuming the same session with "commit what you
  have and continue".
  - Saving up to 47 h/day upper bound. It is uncertain, because some stalls are real hangs.
  - The 22% rewritten share shows some stalls carry information.
- **Check tooling's fail-closed environment refusals** (host environment variables, occupied custody, trusted
  checkout must be clean).
  - Delete the refusals of benign host environment, and repair custody and clean checkouts in place.
  - Saving at least 8 h/day measured, in own attempt-hours. The true figure is likely larger, given that 82% of
    environment endings are unclassifiable.
- **Product-code unjustified constructs** (I, R and F; about 12,000 lines).
  - Delete through ordinary briefs when an area is next touched, guided by the weekly report. No campaign.
  - Saving: small in hours. The value is readability and the examples that new code copies.
- **Tests that pin deleted guards.** Delete them with their guards. Negative test titles are 35% of GPT test titles
  and 25% of Claude's. Most of them are legitimate B and D behaviour, so this is not a count to drive down.

**Move to verification after integration:**

- **"Affected tests introduced failures" and typecheck at dev landing.** These are real catches: 37% rewritten, 95%
  eventually landed.
  - For dev product work, continue the same worker session with the failure in place of ending the attempt, or run
    the check in the dev verifier as `efficiency.md` already directs for dev checks.
  - Saving about 10 h / 5 h per day.

**Keep, with evidence:**

- Money movement guards.
- Authorization and disclosure rules (D).
- Boundary validation (B).
- The undeclared-risk-area fence (6 firings).
- Typecheck as a signal.

**Unmeasured:**

- Inbox caps, `turnsWithoutDecision`, owner-contract decisions and the remaining custody ceremonies. They enter the
  ledger first and get a verdict from their measured firings.

**Total.** Excluding the rebase fix already in flight and the uncertain stall conversion, about 125 h/day upper
bound or 60 h/day conservative. That is roughly 6–13% of the current 940 attempt-hours a day. The stall conversion
would add up to 47 h/day.

## 5. Standing mechanism and owner

| Option                                                               | Catches growth at         | Cost                                           | Verdict                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Efficiency owner prices guards: the maintainer's proposal            | daily audit of the ledger | about one audit turn a day                     | Adopt, given the ledger. Without the ledger it relies on someone noticing, which failed for `44db6f3354`: 116 firings unpriced. |
| Static landing gate on defensive counts                              | every landing             | fails agent work; mostly lexical noise         | Reject. It is a guard against agents.                                                                                           |
| Per-landing simplification review by another model                   | every landing             | one review per landing for about 1.3% of lines | Reject on cost.                                                                                                                 |
| Trust model in brief-writer role text plus a price line in preflight | when the brief is written | about 850 bytes per manager prompt             | Adopt. This is where the experiment moved the design.                                                                           |
| Weekly product density report to Goal managers                       | weekly                    | one script run                                 | Adopt as advisory.                                                                                                              |

**Owner.** The efficiency owner owns the guard ledger, its hourly cost lines and the weekly ratchet. Today that is
the supermanager's efficiency duty, implemented by control-plane workers.

The maintainer's proposal holds, with two conditions:

- the owner works from the typed ledger, not from memory;
- briefs carry the price line, so most guards are never written.

The Goal managers own the deletion of defensive product code in their paths, through ordinary briefs.

## 6. Changes in order

Changes 1–3 are complete briefs. The later changes are smaller and ordered by expected saving.

### Change 1: workers repair contract mismatches instead of stopping

```yaml
goal: control-plane
kind: implementation
paths:
  - tools/goal/prompts/worker.md
  - tools/goal/prompts/conditions/minimal-verification.md
  - tools/goal/src/prompts.ts
  - tools/goal/src/merge-train.ts
  - tools/goal/src/frozen.ts
  - tools/goal/src/*.test.ts
  - tools/goal/prompts/golden/*.txt
  - tools/goal/README.md
riskAreas: []
estimate: { lines: 450, files: 12 }
```

**Outcome.** A worker whose frozen acceptance test, preserved test or brief detail contradicts the contract, an owner
document or delivered code changes the smaller side, lists it and lands. It no longer ends the attempt with
`spec-conflict`. The landing accepts such a frozen-file edit on the dev lane and reports it instead of refusing it.

**Decisions already made:**

- Use the frozen-file line, the blocker sentence and the minimal-verification text exactly as written in the
  research report `docs/research/gpt-defensive-programming-opus-5-5.md` §3.2.
- On the dev lane, `refuseFrozenAcceptanceChange` no longer fails the landing. The landing log records
  `Frozen acceptance file changed: <paths>`, and the owning manager receives one `info` inbox event naming the files.
- Control-plane, stabilize and verification lanes keep today's frozen refusal for now.
- `Research needed:` stays a `spec-conflict` blocker.
- Golden prompt fixtures are regenerated, not hand-edited.

**Acceptance:**

- A dev-lane landing that edits a frozen file integrates. Its landing log names the file, and the manager inbox holds
  one `info` event.
- The rendered worker prompt contains the new frozen-file line and the new blocker opening, and no longer contains
  "must not be edited". The golden fixtures are updated, and the role byte budget test passes.
- The minimal-verification condition permits a focused check and no longer contains "overrides".
- Existing tests that asserted the old refusal or the old wording are updated, and the update is listed.

**Measure.** Spec-conflict stops per 100 attempts in the hourly report, before and after. The target is at least a
60% drop within 48 hours.

### Change 2: brief writers trust agents; the incident method repairs in place

```yaml
goal: control-plane
kind: implementation
paths:
  - tools/goal/prompts/manager.md
  - tools/goal/src/prompts.ts
  - tools/goal/src/*.test.ts
  - tools/goal/prompts/golden/*.txt
  - docs/development/efficiency.md
  - docs/development/verification.md
  - docs/development/agent-conduct.md
  - docs/development/delivery.md
riskAreas: []
estimate: { lines: 150, files: 8 }
```

**Outcome.** Every manager and the supermanager write briefs under the trust model. An incident is answered with a
repair at the point where it appears. Any brief that adds a refusal, stop or failed attempt names the defect it
prevents and its cost.

**Decisions already made:**

- The manager trust block is added verbatim from §3.2 of the research report. It was tested on GPT-6.1 Sol.
- The supermanager's session-start role text receives the same block. The supermanager applies that outside this
  task, in its local configuration.
- `efficiency.md`'s Incident method, the opening paragraph of `verification.md` and the Briefs section of
  `agent-conduct.md` use the §3.2 text.
- `delivery.md`'s brief preflight gains one item: "A requirement that refuses, rejects, stops or fails work has its
  price line; frozen files only for cross-Goal contract cases".
- No other document changes.

**Acceptance:**

- The rendered manager opening contains the trust block and stays within its role byte budget. The golden fixture is
  updated.
- The documents carry the new text, and the old incident sentence ("a control-plane change, a gate or a brief rule
  must prevent recurrence") no longer appears anywhere in `docs/`.
- `bun run --cwd tools/goal typecheck` and the changed test files pass.

**Measure.** Weekly brief register: defensive vocabulary per 100 words and the share of briefs with adversarial
framing, by author. Also the number of new attempt-ending paths added without a price line. The target is zero.

### Change 3: guard ledger, and conversion of zero-information refusals

```yaml
goal: control-plane
kind: implementation
paths:
  - tools/goal/src/guards.ts
  - tools/goal/src/merge-train.ts
  - tools/goal/src/failures.ts
  - tools/goal/src/types.ts
  - tools/goal/src/contracts.ts
  - tools/goal/src/flow.ts
  - tools/goal/src/efficiency-report.ts
  - tools/goal/src/job.ts
  - tools/goal/src/*.test.ts
  - tools/goal/README.md
riskAreas: []
estimate: { lines: 900, files: 14 }
```

**Outcome.** Every path that ends an attempt without landing is a typed `GuardId` with its stated defect, owner and
repair. The hourly report shows each guard's firings, attempt-hours, next-attempt hours, rewritten share and landed
share. The five refusals that carried no information now repair in place:

- "Change had no effect on dev" integrates as already present.
- "No committed changes beyond the base" commits staged or uncommitted work, or accepts "already present" when the
  tree is clean.
- Ignored paths are dropped from the add, unless they are declared paths, which are force-added.
- Outside declared paths on non-dev lanes is listed, not refused, matching the dev rule.
- Estimate overrun no longer ends any attempt.

**Decisions already made:**

- `GuardId` is a string union. `GUARDS: Record<GuardId, { defect: string; owner: string; since: string; repair:
  string }>`.
- Every failing `GateOutcome` sets `refusal.kind`. Every attempt-ending `FailureClass` maps to a `GuardId`, so
  exhaustiveness is enforced by the compiler.
- The report flags a guard "repairable in place" at 20 or more firings and under 10% rewritten over 7 days.
- The undeclared-risk-area fence and typecheck remain guards, with ledger entries.
- Money-movement paths are untouched.

**Acceptance:**

- A test enumerates `GUARDS` and asserts each entry's fields are non-empty.
- A type test fails to compile when a `FailureClass` lacks a `GuardId`.
- Integration tests for the five conversions show each case landing, or integrating as already present, where it
  refused before. Old refusal tests are rewritten to the new outcome and listed.
- `goal report --flow` prints the guard table, with cost columns computed from attempts and events in a fixture
  store.

**Measure.** Weekly guard-hours, which must fall, and the next-attempt hours of the five converted refusals, which
should be about 0 within a day.

### Changes 4 to 7, briefed after the measure of changes 1–3

4. **Check tooling.** Remove refusals of benign host environment values, and repair occupied custody and dirty
   trusted checkouts in place. Owner: the performance Goal. First classify the 1,908 environment endings with no
   stored text by storing the first error line.
5. **Same-session continuation** for stall, round limit, "proof interrupted three times" and repeated assertion on
   non-dev lanes. A third failure triggers the investigation rule, not a stop.
6. **Weekly product density report and simplification briefs** per Goal (§3.3). Include the type-aware redundant
   condition check if `oxlint` provides it.
7. **Replicate §3.1 at scale** before any further prompt change: at least five runs per arm, three incidents and
   three product briefs, blind labels.

## 7. Metrics

Hourly, in the existing flow report and alarm:

- attempt-hours ending without landing, by `GuardId`, with tokens; the three largest are named, and the alarm fires
  above 15% of attempt-hours;
- spec-conflict stops per 100 attempts, and the share followed by an unchanged brief (the false-stop rate);
- frozen-file edits listed by workers: a count, not an alarm.

Weekly:

- **Guard-hours.** The total must fall week over week. Every new `GuardId` carries a price line, and the number added
  without one must be zero.
- **Brief register by author.** Defensive vocabulary per 100 words, adversarial share and refusal share.
- **Product density per area** with the §1.1 detector, plus a blind label sample of 24 lines per engine family for the
  unjustified share.
- **Escaped defects.** Dev verifier `new` findings per 1,000 landed product lines, reverts, and post-integration
  failures traced to a removed guard. Every removed guard gets a watch on the defect it named.
  - The guard removal is reversed only if the defect recurs in a way no agent repaired.
  - If findings per 1,000 lines rise more than 25% after changes 1–3, the frozen-file change is reviewed first.
- **Landing efficiency.** Attempts per integrated task, which the efficiency targets cap at 1.5, and flow efficiency.

## 8. What would change these conclusions

- **The 149 frozen-file refusals.** A blind sample in which most were workers weakening tests to pass, not
  reconciling stale expectations, would keep the frozen refusal for those patterns.
- **The manager experiment.** A replication of at least five runs per arm on three incidents, in which the trust block
  does not move briefs from refusal to repair, would put the weight back on the ledger and the daily audit alone.
- **A larger blind classification.** At least 300 lines with type lookups showing GPT's unjustified share at 1.5 times
  the other engines or more would justify a worker-level countermeasure and a routing test.
- **Escaped defects.** A rise in dev verifier findings per 1,000 lines after the conversions would argue for moving
  those checks to post-integration verification, not back to refusals.
- **Environment endings.** Classifying the 1,908 endings with no stored text could make the check-tooling refusals
  the largest class, which would move change 4 ahead of change 3.
