# Classifying measured growth

Research evidence, inspected 2026-10-27. This report proposes a direction; it does not change the harness contract.

## Recommendation

Use **compatibility with a declared growth model over the whole series**, with a fixed overhead and independently
calibrated count uncertainty. Keep step differences as diagnostics. Do not gate on whichever class has the smallest
least-squares residual. Prefer five geometrically spaced sizes, for example `1, 4, 16, 64, 256`, with the smallest
size already representative of the query's intended plan. Retain the planned repetitions and warm-ups, retain their
raw counts, and return an explicit insufficient-evidence outcome when noise or range prevents discrimination.

This is a recommendation derived from the sources below, not a method or numerical tolerance endorsed by all of
them. None establishes that three sizes and a universal percentage can provide both reliable classification and
arbitrarily small regression detection. Finite measurements establish behavior over the measured range, not a
mathematical asymptotic bound. [Input-sensitive profiling, section 2.3][input-paper]

## What established tools actually do

| Tool or study                     | Sizes and spacing                                                                                                                                                                            | Estimation and noise policy                                                                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Benchmark                  | Caller supplies sizes; the complexity example uses nine powers of two, `2^10` through `2^18`. The fitter requires at least two reports; that is an API minimum, not a reliability guarantee. | Fits candidate curves by least squares, reports normalized RMS, and can select the best curve. Repetition statistics are separate; complexity fitting supplies no pass/fail confidence threshold. [Guide][google-guide], [implementation][google-fit]                         |
| Goldsmith et al., trend-prof      | Bubble-sort illustration: ten sizes from 60 to 60,000, three random arrays per size. Real-program studies use hundreds of workloads. No prescribed universal spacing.                        | Linear and log-log power-law regression; residual plots, fit quality, and bootstrap intervals characterize evidence. [Sections 2-5][trend-paper]                                                                                                                              |
| AlgoProf, algorithmic profiling   | Published examples use ten sizes `0, 10, ..., 90` or 1,000 sizes `1, ..., 1000`, with three iterations per size. These are example programs, not a sampling standard.                        | The prototype's official example explicitly says curves were fitted manually. Do not describe its displayed curves as an automatic classifier. [Project example][algoprof-example]                                                                                            |
| aprof, input-sensitive profiling  | Observes whichever routine input sizes occur, potentially in one program run; no fixed count or geometric schedule.                                                                          | Aggregates min/max/mean/variance by input size; curve fitting and plots of cost divided by a candidate function. The later viewer fits an offset power law and offers smoothing. [PLDI paper][input-paper], [viewer paper][aprofplot-paper]                                   |
| Python `big_O`                    | Defaults to ten **linearly** spaced sizes, 100 through 100,000.                                                                                                                              | Least squares across candidate classes, an absolute residual preference for simpler classes, and configurable minimum-of-timings measurement. It does not supply a statistically calibrated acceptance gate. [Measurement/selection][python-measure], [models][python-models] |
| MongoDB CI change-point detection | Measurements ordered by revision, typically 100-500 observations in the reported deployment, rather than different input sizes.                                                              | E-Divisive means detects distribution changes and assesses significance using permutations; it replaced a problematic fixed percentage comparison. [ICPE paper][mongo-paper], [implementation][mongo-fit]                                                                     |
| rustc-perf                        | Compares revisions of the same benchmark; source uses 30 previous commits for historical noise analysis.                                                                                     | Per-case historical relative differences determine an IQR fence; no-history fallback is 0.2%. Instruction counts receive different magnitude treatment from noisier metrics. [Implementation][rust-fit]                                                                       |

### Google Benchmark: curve selection is descriptive

`Complexity(oN)` fixes the curve; `Complexity()` uses automatic selection; a lambda supplies a custom curve.
`SetComplexityN` supplies the independent variable. The source tries constant, log, linear, linearithmic, quadratic,
and cubic forms. For each `g(n)`, it fits `y = c*g(n)` through the origin:

```text
c = sum(y_i*g(n_i)) / sum(g(n_i)^2)
normalized RMS = sqrt(mean((y_i - c*g(n_i))^2)) / mean(y_i)
```

Despite a source comment mentioning relative error, the actual formula minimizes **unweighted squared errors**;
normalization occurs afterward. There is no fitted intercept, outlier rejection, or rule rejecting an inadequate
best fit. The zero-mean case even receives RMS zero. Complexity accumulation uses per-iteration CPU/real times,
not arbitrary custom counters. This is useful reporting machinery, not a ready-made bound assertion for rows or
blocks. [Source: `src/complexity.cc`, `MinimalLeastSq`, `ComputeBigO`][google-fit]

The guide separately exposes repetitions, median, standard deviation, coefficient of variation, and warm-up
controls. It does not specify an RMS percentage that proves a class or a universal number of sizes.
[Source: `docs/user_guide.md`, complexity and statistics sections][google-guide]

### Empirical complexity: rich workloads and uncertainty

trend-prof counts executed basic blocks. Its linear model is `a+b*n`; its power-law model is `a*n^b`, fitted after
log transformation. It reports residual plots, R-squared, and 95% bootstrap intervals for coefficients and
predictions. Its bubble-sort sizes are `60, 200, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000`: roughly
geometric, spanning three orders of magnitude. The paper deliberately avoids tiny sizes where lower-order terms
dominate. Real-program workload counts are 277, 785, 910, and 1,000. Counts are exact and repeatable **conditional
on deterministic control flow**; variation across workloads can still remain. These are exploratory models, not
three-point CI assertions. [Sections 2.1, 2.3, 3, 4.2; figure 3][trend-paper]

AlgoProf's official artifact demonstrates a different approach: exposing repetitions and their inputs, with
manually added cost curves. Its illustrative sampling schedules differ greatly even between two insertion-sort
implementations. That is evidence against inferring a required sample count from a profiler screenshot.
[Official example and limitation notice][algoprof-example]

aprof estimates routine input using read memory size: distinct cells first accessed by reading. It retains call
frequency, min/max cost, sum and sum of squares at each size, allowing different best/average/worst-case profiles.
This can supply many sizes in one run. The paper also warns that this input proxy changes the question for
sublinear routines: binary search reads only logarithmically many cells. Keep this harness's explicit dataset size
as the independent variable. [Sections 2.1-2.3][input-paper]

The later aprof-plot viewer fits `a+b*n^c`; its source uses a Levenberg-Marquardt fitter and records R-squared.
The paper's example filters for **more than ten distinct input-size tuples**, `R² > 0.92`, and `b > 0.01`.
Those are exploratory filtering criteria. Noise reduction groups adjacent points or applies a moving average;
one illustration uses a window of 256 points. Neither smoothing nor those thresholds transfers sensibly to three
or five samples. [Sections 3.2-3.3][aprofplot-paper], [`fitter.java`][aprof-fit]

### Python estimation: a best fit still needs an adequacy test

`big_O` uses `numpy.linspace`, `timeit`, and the minimum of `n_timings` measurements. Defaults are one timing and
one invocation per size, so minimum selection adds no robustness by default. `n_repeats` accumulates invocations
within a timing; it is not a number of distinct sizes. `infer_big_o_class` prefers an earlier, simpler class unless
another improves squared residuals by more than `simplicity_bias=1e-6`. This absolute, unit-dependent bias is not
a significance level. [Source: `big_o/big_o.py`][python-measure]

Constant has one parameter; log, linear, quadratic and linearithmic forms include an intercept. The library uses
`numpy.linalg.lstsq`; transformed power/exponential models recompute residuals in the original output units.
There is no independent rejection criterion for all classes fitting badly. The useful pattern is to expose all
fits and raw data, rather than hide them behind one label. [Source: `big_o/complexities.py`][python-models]

### CI detection: learn noise per series, and separate significance from importance

MongoDB's paper reports that a common 10% threshold produced false alerts on noisy tests while missing small
changes in quiet ones. Its replacement examines changes between distributions of revision-ordered measurements;
the reported deployment typically analyzes 100-500 points. The inspected library's `e_divisive` defaults to
`pvalue=0.05` and 100 permutations. Its shuffled data are existing observations, not new benchmark executions.
These defaults are not a guarantee of suite-wide false-positive control. [Sections 1-3][mongo-paper],
[`_get_next_significant_change_point`, `e_divisive`][mongo-fit]

rustc-perf provides a closer counted-metric example. Its source computes absolute adjacent historical relative
changes over 30 prior commits and uses `Q3 + 3*(Q3-Q1)` as the significance threshold. The documentation's prose
says 1.5 IQR, but its formula and executable source say **3 IQR**; use the source when describing the behavior.
The no-history fallback is 0.002 in fractional units. Separately, magnitude buckets treat user instructions as
less noisy than other metrics. This is an empirical outlier rule, not a calibrated p-value or complexity fit.
[`site/src/comparison.rs`, `HistoricalDataMap`, `HistoricalData`, `TestResultComparison`, `MetricExt`][rust-fit],
[documentation discrepancy][rust-doc]

These CI systems operate on revisions at fixed workloads. Applying change-point detection directly to increasing
input sizes would confuse intended growth with a regression. Transfer their noise calibration and effect-size
separation, not the independent variable or their numerical defaults.

## Implications for counted database work

An exact counter can measure variable work. PostgreSQL documents buffer counts as **non-distinct** accesses,
including child nodes; they are not unique pages. The harness sums shared hits and reads, so a pure hit-to-read
substitution does not increase that sum. A rise warrants inspection of plans, relation costs and database state;
the three numbers alone do not establish host load as its cause. [PostgreSQL EXPLAIN guide][postgres-explain],
[local aggregation][local-cost]

The current rule uses `A=max(absolute, relative*y0)`. Constant checks compare every larger value with `y0`;
logarithmic checks allow `d2 <= 2*max(d1,0)+A`; linear checks allow
`d2 <= 1.5*r*max(d1,0)+A`. It validates exactly three equally ratio-spaced samples, with `r >= 4`.
Thus the constant failure is not actually a second-step comparison, despite the error message wording.
[Local implementation][local-bound]

The weakness is not just the chosen percentage. A noisy first difference becomes permission for the next one,
and the middle observation participates twice. Under equal geometric spacing, ideal log differences are equal;
ideal linear differences grow by `r`. For a contrast `d2-k*d1`, count errors each bounded in magnitude by `E`
can move the contrast by up to `(2+2*k)*E`. This is a worst-case arithmetic bound, not a statistical assumption.
A step allowance unrelated to this propagation can be either too tight or too permissive.

For `15, 15, 23`, the current constant allowance is 7.5, so the observed range of 8 fails. If independently
established uncertainty were ±4 **per median**, all three intervals would contain 19. Constant work is then
compatible with the data. This arithmetic example does not establish ±4 as the correct tolerance, nor prove
constant growth. Increasing a threshold to eight merely because this case failed would be circular.

## A concrete policy the manager can adopt

1. **Measure five sizes by default.** Use equal geometric ratios, initially ×4, and preserve at least the current
   64-fold range. `1,4,16,64,256` expands it to 256-fold; four sizes `1,4,16,64` are a budget-constrained fallback
   with weaker evidence. Three sizes remain a smoke check. Five points leave three residual degrees of freedom
   for a two-parameter model; this is a design compromise, not a statistical sufficiency theorem. Scale actual
   relation cardinalities, including distractor relations, and report them. A plateau caused by not growing a
   relevant input is not evidence of constant work. Keep workload shape and result cardinality controlled.

2. **Keep overhead explicit and bound semantics explicit.** Evaluate `a`, `a+b*log(n/n0)`, and
   `a+b*(n/n0-1)`, with `a,b >= 0`. A declared logarithmic bound may pass as constant; a linear bound may pass
   as constant or logarithmic. These are operational curve families over the tested range, not all functions in
   a mathematical Big-O class. A B-tree depth jump or batching boundary needs a documented discretization
   allowance or an appropriate model. Do not force every valid staircase into a smooth curve with zero residual.

3. **Freeze tolerances independently of the candidate series.** Retain the existing five planned repetitions at
   each size and store the individual counts alongside their medians; currently `growth.ts` discards the array
   after `medianCost`. Calibrate absolute floors and any proportional component separately for statements,
   rows and blocks, using unchanged-code historical series with comparable plans, dataset state and concurrency.
   Include between-series variation; within-size MAD can be zero even when all repetitions share a shifted
   state. Keep statements exact when determinism is established. Do not import timing-oriented minimum selection
   as a default for counts: the cheapest execution can hide real work. [Local measurement loop][local-growth]

4. **Use a deterministic compatibility test across every size.** Given independently chosen uncertainties `E_i`,
   ask whether an allowed family has parameters placing every prediction in
   `[max(0,y_i-E_i), y_i+E_i]`. This is a small linear feasibility problem for the fixed constant/log/linear bases.
   Equivalently minimize the largest absolute residual divided by `E_i`, and accept compatibility at most one;
   `E_i=0` means an exact constraint. Unlike mean-normalized RMS, this preserves sensitivity to a small absolute
   discrepancy at low counts. Do not estimate `E_i` from the residuals of the curve being judged. Report ordinary
   least-squares fits, residuals, and adjacent differences for diagnosis, without making the winning label a gate.

5. **Specify the detectable effect before choosing the tolerance.** Choose a suite-level false-alert budget and
   calibrate the maximum discrepancy across sizes/metrics on independent unchanged-code histories, rather than
   assigning 5% separately to each comparison. A held-out upper quantile of those maxima is one empirical option;
   finite history limits confidence in extreme quantiles. Use independently specified linear/superlinear count
   traces as positive controls and state the smallest extra scan or per-row work the available range can detect.
   These are future calibration checks, not experiments performed for this report. If noise hides that effect,
   widen the size range or improve isolation; increasing slack cannot repair sensitivity. Avoid a universal 50%
   block allowance: it scales the blind spot with fixed startup cost.

6. **Decide once from the scheduled measurements.** Compatible with an allowed family means no detected bound
   violation at the stated detection resolution; it does not identify an exact class. A higher-class model with
   zero or undetectably small growth is not a competing regression. Incompatible with every allowed family,
   with uncertainty still inside calibration, means a measured contract violation. Call it evidence of a class
   change only when a higher-growth model is compatible and the excess persists over multiple large sizes;
   otherwise report lack of fit or a state/plan transition. If current dispersion exceeds calibration, positive
   controls cannot establish the promised resolution, or a prohibited effect at that resolution remains compatible
   with the allowed explanation, report insufficient evidence with the raw counts, intervals and diagnostics.
   Do not silently pass an invalid measurement or retry until green. Distinguishing overlapping explanations is
   impossible without additional assumptions or data; no classifier can promise it from `15,15,23` alone. An
   inconclusive measurement can fail the verification job distinctly, without claiming an asymptotic regression.

The shared patterns are wide input coverage, explicit model/feature choices, retained variation, and diagnostics
that allow inadequate evidence to remain inadequate. The research supports those patterns; it does not validate
new numerical count tolerances. Adoption and any runtime/API changes belong in the owning harness document.

## Source locations, versions and reuse

All repositories were shallow-cloned and read as untrusted data. Nothing from them was installed, built, or
executed. To obey the workspace-only write restriction and `AGENTS.md`, reference clones and paper downloads are
in ignored `.temp/growth-classification-refs/` inside this worktree, instead of the external temporary directory.
Only this report is a tracked change. Papers and source files were read; no external implementation was copied.

| Source           | Inspected version and paths                                                                                                                                                                                        | Licence or reuse status                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Benchmark | `0a78b5d203283b54f65590ecef23e0b835b4787c`; `src/complexity.cc`, `docs/user_guide.md`                                                                                                                              | [Apache-2.0, `LICENSE`][google-license]                                                                                                        |
| trend-prof study | Goldsmith, Aiken, Wilkerson, _Measuring Empirical Computational Complexity_, ESEC/FSE 2007, pp. 395-404; [author-hosted paper][trend-paper], also [university-hosted copy read][trend-copy]                        | ACM copyright notice with limited personal/classroom permission; no permissive source licence established here.                                |
| AlgoProf         | Zaparanuks and Hauswirth, _Algorithmic Profiling_, PLDI 2012, pp. 67-76; [official publication record][algoprof-paper], official example, [prototype archive listing][algoprof-archive]                            | ACM paper; no permissive prototype licence established. Example and archive do not grant code-copy permission for this task.                   |
| aprof            | Coppa, Demetrescu, Finocchi, _Input-sensitive Profiling_, PLDI 2012, pp. 89-98; source `2b985519faff819acff382d01f0d739627c51f21`: `valgrind/aprof/aprof.h`, `aprofplot/src/aprofplot/{Input,Routine,fitter}.java` | [Repository `LICENSE` is GPL-2.0][aprof-license]; `aprof.h` states version 2 or later. PLDI paper bears ACM copyright. Pattern reference only. |
| aprof-plot study | Coppa, _An Interactive Visualization Framework for Performance Analysis_, VALUETOOLS 2014, pp. 159-164; sections 3.2-3.3 and figures 2, 4-5                                                                        | [Author/lab-hosted manuscript][aprofplot-paper]; no permissive code licence established by that manuscript.                                    |
| Python `big_O`   | `88b4df9f14222d3360d5986aace6dff7faf54358`; `big_o/big_o.py`, `big_o/complexities.py`                                                                                                                              | [BSD-3-Clause, `LICENSE.txt`][python-license]                                                                                                  |
| MongoDB          | Daly et al., ICPE 2020, pp. 67-75; source `aec099a9696d17ccd1e85a357313614a01f859a2`: `src/signal_processing_algorithms/energy_statistics/energy_statistics.py`                                                    | [Paper is CC-BY-4.0][mongo-paper]; [library `LICENSE` is Apache-2.0][mongo-license]. This does not imply a licence for MongoDB server code.    |
| rustc-perf       | `a2b91914f4849e931d403ca32e34465676265be9`; `site/src/comparison.rs`, `docs/comparison-analysis.md`, `REUSE.toml`                                                                                                  | [MIT for inspected `site/**` and `docs/**`, per `REUSE.toml`][rust-license]; vendored benchmarks have their own licences.                      |
| PostgreSQL       | Version 18 EXPLAIN documentation, `/docs/18/using-explain.html`, section 14.1                                                                                                                                      | [PostgreSQL licence covers software and documentation][postgres-license]; used as documentary evidence.                                        |

Patterns may be followed freely. Under this task's code-reuse rule, copy code only from MIT, Apache-2.0 or BSD
projects, with attribution and their required notices. GPL, unknown-licence artifacts, and paper availability do
not qualify. This report recommends independently implementing the statistical patterns, not porting source.

[google-guide]: https://github.com/google/benchmark/blob/0a78b5d203283b54f65590ecef23e0b835b4787c/docs/user_guide.md#asymptotic-complexity
[google-fit]: https://github.com/google/benchmark/blob/0a78b5d203283b54f65590ecef23e0b835b4787c/src/complexity.cc
[google-license]: https://github.com/google/benchmark/blob/0a78b5d203283b54f65590ecef23e0b835b4787c/LICENSE
[trend-paper]: https://theory.stanford.edu/~aiken/publications/papers/fse07.pdf
[trend-copy]: https://www.cs.ubc.ca/labs/algorithms/EARG/stack/2007_ESEC_GoldSmith_MeasuringEmpiricalComplexity.pdf
[algoprof-paper]: https://sape.inf.usi.ch/publications/pldi12
[algoprof-example]: https://sape.inf.usi.ch/algorithmic-profiling/example.html
[algoprof-archive]: https://sape.inf.usi.ch/sites/default/files/algoProf-0.9.zip
[input-paper]: https://season-lab.github.io/papers/pldi055-coppa.pdf
[aprofplot-paper]: https://season-lab.github.io/papers/aprofplot.pdf
[aprof-fit]: https://github.com/ercoppa/aprof/blob/2b985519faff819acff382d01f0d739627c51f21/aprofplot/src/aprofplot/fitter.java
[aprof-license]: https://github.com/ercoppa/aprof/blob/2b985519faff819acff382d01f0d739627c51f21/LICENSE
[python-measure]: https://github.com/pberkes/big_O/blob/88b4df9f14222d3360d5986aace6dff7faf54358/big_o/big_o.py
[python-models]: https://github.com/pberkes/big_O/blob/88b4df9f14222d3360d5986aace6dff7faf54358/big_o/complexities.py
[python-license]: https://github.com/pberkes/big_O/blob/88b4df9f14222d3360d5986aace6dff7faf54358/LICENSE.txt
[mongo-paper]: https://research.spec.org/icpe_proceedings/2020/proceedings/p67.pdf
[mongo-fit]: https://github.com/mongodb/signal-processing-algorithms/blob/aec099a9696d17ccd1e85a357313614a01f859a2/src/signal_processing_algorithms/energy_statistics/energy_statistics.py
[mongo-license]: https://github.com/mongodb/signal-processing-algorithms/blob/aec099a9696d17ccd1e85a357313614a01f859a2/LICENSE
[rust-fit]: https://github.com/rust-lang/rustc-perf/blob/a2b91914f4849e931d403ca32e34465676265be9/site/src/comparison.rs
[rust-doc]: https://github.com/rust-lang/rustc-perf/blob/a2b91914f4849e931d403ca32e34465676265be9/docs/comparison-analysis.md
[rust-license]: https://github.com/rust-lang/rustc-perf/blob/a2b91914f4849e931d403ca32e34465676265be9/REUSE.toml
[postgres-explain]: https://www.postgresql.org/docs/18/using-explain.html
[postgres-license]: https://www.postgresql.org/about/licence/
[local-bound]: ../../services/kernel/test/support/growth-bound.ts
[local-cost]: ../../services/kernel/test/support/growth-cost.ts
[local-growth]: ../../services/kernel/test/support/growth.ts
