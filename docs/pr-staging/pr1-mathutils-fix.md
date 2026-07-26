`orientation()` compares the cross product against exactly `0`. For colinear
input the true cross product *is* 0, so the computed value is pure
floating-point cancellation dust whose **sign is meaningless** — and
`doSegmentsIntersect()` then trusts that sign in its general case
(`o1 !== o2 && o3 !== o4`) and reports the segments as intersecting.

Reproduction on current `main` (coordinates captured from a real PCB autoroute;
both segments lie exactly on `y = x - 19.2`, 0.424mm apart):

```ts
const a1 = { x: 19.45000000000001, y: 0.25 }
const a2 = { x: 19.35000000000001, y: 0.15 }
const b1 = { x: 18.950000000000003, y: -0.25 }
const b2 = { x: 19.050000000000004, y: -0.15 }

doSegmentsIntersect(a1, a2, b1, b2)        // true   (expected false)
segmentToSegmentMinDistance(a1, a2, b1, b2) // 0     (expected 0.4243)
```

The four cross products evaluate to `0, 3.469e-18, 0, 3.469e-18` → classified
`0, 1, 0, 1` → "intersecting".

**Why it matters beyond this function:** every clearance check built on the
predicate inherits the false zero. `@tscircuit/checks` computes
`gap = segmentToSegmentMinDistance(a, b) - thicknessA/2 - thicknessB/2` for
`pcb_trace_clearance_error`, so a false 0 becomes a false clearance violation.
Colinear geometry is the common case on PCBs (traces sharing a 45°/90° line).

**Fix:** treat `|cross|` within a relative tolerance of the operand magnitude as
colinear (1e-12 — about four orders of magnitude above double cancellation error
and far below any geometrically meaningful area). Disjoint colinear segments then
fall through to the existing `onSegment()` bounding-box checks, which reject them
correctly.

**Tests:** `tests/colinear-robustness.test.ts`, 11 cases — the captured
coordinates, dust classification, and preservation of genuine crossings,
T-junctions, shared endpoints, overlapping colinear segments and shallow-angle
crossings. 3 fail before the change; suite is 138/138 after.
