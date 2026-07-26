**Question / possible correctness bug found while instrumenting the intra-node
portfolio.**

While building a deterministic replay of `HyperParameterSupervisorSolver`'s
candidate schedule (running every candidate to completion in workers, then
simulating the sequential fitness schedule over their recorded trajectories),
548 of 550 nodes on srj18 sample 5 replayed to the exact sequential winner —
but one node exposed a cache-consistency question:

At node `cmn_51`, the sequential pipeline consults `CachedIntraNodeRouteSolver`
and replays a **cached FAILED attempt**, while a cold-cache worker solving the
byte-identical node input succeeds.

If the cache key does not include everything that affects solvability at the
time of the attempt (solved routes present, obstacle state, hyperparameter
set), then a failure cached under one pipeline state can be served under a
different, more permissive state — i.e. failure entries can poison later
solves of the same node, silently degrading results.

Questions:
1. What exactly goes into the intra-node cache key?
2. Is caching *failures* (as opposed to successes) intentional?
3. If the key is intentionally partial for hit-rate, should failure entries be
   excluded, or keyed more strictly than successes?

Happy to provide the instrumentation and the `cmn_51` repro details.
