# Fact-calibration subset

Representative labelled claims for method-quality calibration (FACT05). The file
`claims.jsonl` is a 384-claim subset of the FEVER shared-task development set.
It is balanced across the three FEVER verdicts and eight coarse topical strata.
It is not a scored evaluation of a REZICS method.

## Provenance

| | |
| --- | --- |
| Dataset | FEVER (Fact Extraction and VERification) |
| Version | Shared-task labelled development set, as published for the dataset |
| Source page | https://fever.ai/dataset/fever.html |
| Download | https://fever.ai/download/fever/shared_task_dev.jsonl |
| Retrieved | 2026-09-27 |
| Size | 19,998 lines, 4,349,935 bytes |
| SHA-256 | `e89865bfe1b4dd054e03dd57d7241a6fde24862905f31117cf0cd719f7c78df7` |

The checksum above is of that download. The development file is the labelled
split the FEVER site publishes separately from the training file, so this
subset is held out from FEVER training data. Claims were written by annotators
who altered sentences from the June 2017 English Wikipedia dump used by FEVER.
`claims.jsonl` does not include Wikipedia article text.

## Licence and attribution

Checked against https://fever.ai/download/fever/license.html on 2026-09-27.
That page says:

> These data annotations incorporate material from Wikipedia, which is licensed
> pursuant to the Wikipedia Copyright Policy. These annotations are made
> available under the license terms described on the applicable Wikipedia
> article pages, or, where Wikipedia license terms are unavailable, under the
> Creative Commons Attribution-ShareAlike License (version 3.0), available at
> http://creativecommons.org/licenses/by-sa/3.0/ (collectively, the “License
> Terms”). You may not use these files except in compliance with the applicable
> License Terms.

`claims.jsonl` and the stratum counts in `manifest.json` are an adaptation of
that development file and are shared under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). This notice
covers those data files. It does not relicense the rest of the repository.

Changes from the source file: a seeded stratified subset; a `domain` field
derived from the claim text; evidence reduced to Wikipedia title and sentence
id, with FEVER's internal annotation ids removed; near-duplicate claims inside
a stratum omitted by the sampler described below.

Attribute the dataset to James Thorne, Andreas Vlachos, Christos
Christodoulopoulos, and Arpit Mittal, and the incorporated Wikipedia material
to Wikipedia contributors.

Thorne, James, Andreas Vlachos, Christos Christodoulopoulos, and Arpit Mittal.
2018. [FEVER: a Large-scale Dataset for Fact Extraction and
VERification](https://aclanthology.org/N18-1074/). In *Proceedings of the 2018
Conference of the North American Chapter of the Association for Computational
Linguistics: Human Language Technologies, Volume 1 (Long Papers)*, pages
809–819. https://doi.org/10.18653/v1/N18-1074

## Selection

`selection.ts` is the procedure. `manifest.json` records the seed, the source
checksum, and the selected and pool count of every stratum.

- Seed: `g-116-fact-calibration-v1`.
- Stratum: FEVER `label` × `domain`. Labels are `SUPPORTS`, `REFUTES`, and
  `NOT ENOUGH INFO`. Sixteen claims are kept from each of the 24 strata.
- Domain is a coarse tag of the claim wording, not a Wikipedia category. The
  same function is used for every label because `NOT ENOUGH INFO` rows have no
  evidence page. A parenthetical disambiguator such as `(film)` is tested from
  left to right; otherwise the first keyword rule in `selection.ts` wins.
  Claims that match nothing are `other`. A claim that says a film is a book is
  tagged from those words, which is what the claim asserts.
- Rank is the SHA-256 hex of `seed`, a newline, and the decimal FEVER id,
  lowest first. Ties break by id.
- While walking that order, a claim whose token Jaccard overlap with an
  already kept claim in the same stratum is at least 0.5 is skipped.
- Output order is domain, then label, then rank. Each JSON line has `id`,
  `label`, `domain`, `claim`, and `evidence` (`[wikipedia title, sentence id]`).

The tagger is deliberately small. `Planet Hollywood` is not science, and
`United Kingdom` is not a kingdom stratum, but a corporate "president" or a
metaphorical match can still land in the wrong stratum. The calibration label
remains the FEVER verdict.

Regenerate from a copy of the development file whose SHA-256 matches the
manifest:

```sh
bun tests/qa/fixtures/fact-calibration/selection.ts path/to/shared_task_dev.jsonl
```

The writer refuses a different checksum or line count. The subset checksum in
`manifest.json` is SHA-256 of `claims.jsonl` as committed.
