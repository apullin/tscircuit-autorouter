`GrowShrinkHighDensityIntraNodeSolver` bounds a single growth attempt by
assigning `activeSubSolver.MAX_ITERATIONS`. `PortfolioSingleIntraNodeSolver`
then recomputes `MAX_ITERATIONS` in `refreshDynamicIterationLimit()` from the
remaining candidate budgets — on its first step, and again on every portfolio
expansion — so the cap was discarded immediately. Observed on the added
fixture: a cap of 25 becomes 45,128.

The `maxInnerIterationsPerGrowthAttempt` parameter has therefore never had any
effect on this path, and a growth attempt always ran to the portfolio's own
dynamic budget before the node was grown and retried.

**Fix:** an explicit `externalMaxIterations` ceiling on the portfolio that the
dynamic limit respects, set by GrowShrink alongside the existing assignment.
No production caller currently sets the parameter (neither pipeline supplies
it), so default behavior is byte-identical; the fix only makes the documented
parameter actually work for callers who pass it.

**Tests:** `tests/features/never-fail-growth-high-density/caps-inner-iterations.test.ts`
covers both the wiring (a busy 4-connection node whose inner solver is still
running after one step) and the portfolio ceiling itself. Both fail before this
change and pass after.

Suite: 419 pass / 55 skip / 2 fail; the two failures (`bugreport36-d4c6c2` and
`dip16 crossing traces 1206x4`) reproduce identically on an unmodified checkout
of this commit's parent (v0.0.717), so they are pre-existing and unrelated.
