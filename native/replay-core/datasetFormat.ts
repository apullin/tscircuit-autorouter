/**
 * RPLYDS01 dataset format — captured portfolio-candidate trajectories for
 * deterministic winner-schedule replay (see README.md in this directory).
 *
 * Layout (little-endian, the native byte order of every box we run on):
 *   bytes 0..8    magic ASCII "RPLYDS01" (version is part of the magic)
 *   bytes 8..12   u32 headerLen (bytes of header JSON, INCLUDING pad spaces)
 *   bytes 12..12+headerLen
 *                 UTF-8 header JSON, space-padded so (12 + headerLen) % 4 == 0
 *   bytes 12+headerLen..end
 *                 payload: concatenated f32 trajectories (see below)
 *
 * Header JSON:
 * {
 *   "version": 1,
 *   "sampleStride": 100,           // MUST equal MIN_SUBSTEPS
 *   "nodes": [{
 *     "nodeId": "...",
 *     "nodeSegmentCount": 3,       // PortfolioSingleIntraNodeSolver.getNodeSegmentCount()
 *     "initialCount": 70,          // candidates before adaptive expansion
 *     "capturedWinnerIndex": 5,    // winner the live TS replay picked (-1 none)
 *     "candidates": [{
 *       "hp": {...},               // hyperParameters (only the candidateG-relevant
 *                                  // keys are read by the replay)
 *       "solved": true,
 *       "iterations": 1234,        // final solver.iterations
 *       "maxIterations": 100000,   // post-setup MAX_ITERATIONS
 *       "solvedSegments": 3,       // final count, -1 if no solvedConnectionsMap
 *       "trajOffset": 0,           // in f32 elements from payload start
 *       "trajLen": 13              // number of schedule-grid samples
 *     }, ...]
 *   }, ...]
 * }
 *
 * Schedule-grid trajectories: the replay (replayPool.ts:187-260) only ever
 * evaluates progress at virtual iteration counts v = min(k*100, iterations),
 * k >= 1, because v advances by min(MIN_SUBSTEPS=100, iterations - v)
 * (replayPool.ts:252) and progress is read as raw[min(v, rawLen) - 1]
 * (replayPool.ts:203-206). Storing only those samples decimates the raw
 * per-iteration trajectory 100x while remaining BIT-EXACT:
 *
 *   grid[k-1] = raw[min(min(k*100, iterations), rawLen) - 1]
 *   lookup(v) = grid[min(ceil(v/100), trajLen) - 1]   (v > 0)
 *             = raw[min(v, rawLen) - 1]               for every reachable v
 *   rawLen == 0 (e.g. candidate solved/failed at construction) => trajLen = 0
 *   and lookup(v) = 0, matching the original idx = -1 branch.
 */

export const MAGIC = "RPLYDS01"
export const FORMAT_VERSION = 1
/** Must equal MIN_SUBSTEPS (PortfolioSingleIntraNodeSolver.ts:261). */
export const SAMPLE_STRIDE = 100

export type DatasetCandidate = {
  hp: Record<string, unknown>
  solved: boolean
  iterations: number
  maxIterations: number
  solvedSegments: number
  /** schedule-grid samples (see module doc) */
  traj: Float32Array
}

export type DatasetNode = {
  nodeId: string
  nodeSegmentCount: number
  initialCount: number
  capturedWinnerIndex: number
  candidates: DatasetCandidate[]
}

/**
 * Decimate a raw per-iteration trajectory (portfolioReplayWorker.ts:99-107;
 * possibly truncated by the 24MB SAB sample cap) to the schedule grid.
 */
export const decimateTrajectory = (
  progress: Float32Array,
  iterations: number,
): Float32Array => {
  const rawLen = progress.length
  if (rawLen === 0) return new Float32Array(0)
  const n = Math.ceil(iterations / SAMPLE_STRIDE)
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const vit = Math.min((k + 1) * SAMPLE_STRIDE, iterations)
    out[k] = progress[Math.min(vit, rawLen) - 1]!
  }
  return out
}

export const encodeDataset = (nodes: DatasetNode[]): Uint8Array => {
  let totalSamples = 0
  const headerNodes = nodes.map((n) => ({
    nodeId: n.nodeId,
    nodeSegmentCount: n.nodeSegmentCount,
    initialCount: n.initialCount,
    capturedWinnerIndex: n.capturedWinnerIndex,
    candidates: n.candidates.map((c) => {
      const trajOffset = totalSamples
      totalSamples += c.traj.length
      return {
        hp: c.hp,
        solved: c.solved,
        iterations: c.iterations,
        maxIterations: c.maxIterations,
        solvedSegments: c.solvedSegments,
        trajOffset,
        trajLen: c.traj.length,
      }
    }),
  }))
  const headerJson = JSON.stringify({
    version: FORMAT_VERSION,
    sampleStride: SAMPLE_STRIDE,
    nodes: headerNodes,
  })
  let headerBytes: Uint8Array = new TextEncoder().encode(headerJson)
  const pad = (4 - ((12 + headerBytes.byteLength) % 4)) % 4
  if (pad > 0) {
    const padded = new Uint8Array(headerBytes.byteLength + pad)
    padded.set(headerBytes)
    padded.fill(0x20, headerBytes.byteLength) // trailing spaces: JSON-legal
    headerBytes = padded
  }
  const payloadOffset = 12 + headerBytes.byteLength
  const out = new Uint8Array(payloadOffset + totalSamples * 4)
  for (let i = 0; i < 8; i++) out[i] = MAGIC.charCodeAt(i)
  new DataView(out.buffer).setUint32(8, headerBytes.byteLength, true)
  out.set(headerBytes, 12)
  const payload = new Float32Array(out.buffer, payloadOffset, totalSamples)
  let cursor = 0
  for (const n of nodes) {
    for (const c of n.candidates) {
      payload.set(c.traj, cursor)
      cursor += c.traj.length
    }
  }
  return out
}

/**
 * Decode a dataset. `bytes` must view its buffer at a 4-byte-aligned offset
 * (a freshly copied `new Uint8Array(buffer)` always does).
 */
export const decodeDataset = (bytes: Uint8Array): DatasetNode[] => {
  if (bytes.byteLength < 12) throw new Error("dataset too short (< 12 bytes)")
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) {
      throw new Error("bad magic (want RPLYDS01)")
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLen = view.getUint32(8, true)
  const payloadOffset = 12 + headerLen
  if (payloadOffset > bytes.byteLength) {
    throw new Error("header extends past end of buffer")
  }
  if ((bytes.byteOffset + payloadOffset) % 4 !== 0) {
    throw new Error("payload not 4-byte aligned")
  }
  if ((bytes.byteLength - payloadOffset) % 4 !== 0) {
    throw new Error("payload size not a multiple of 4")
  }
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(12, payloadOffset)),
  ) as {
    version: number
    sampleStride: number
    nodes: Array<{
      nodeId?: string
      nodeSegmentCount: number
      initialCount: number
      capturedWinnerIndex?: number
      candidates: Array<{
        hp?: Record<string, unknown>
        solved: boolean
        iterations: number
        maxIterations: number
        solvedSegments?: number
        trajOffset: number
        trajLen: number
      }>
    }>
  }
  if (header.version !== FORMAT_VERSION) {
    throw new Error(`unsupported dataset version ${header.version}`)
  }
  if (header.sampleStride !== SAMPLE_STRIDE) {
    throw new Error(
      `sampleStride ${header.sampleStride} does not match MIN_SUBSTEPS ${SAMPLE_STRIDE}`,
    )
  }
  const payload = new Float32Array(
    bytes.buffer,
    bytes.byteOffset + payloadOffset,
    (bytes.byteLength - payloadOffset) / 4,
  )
  return header.nodes.map((n, ni) => ({
    nodeId: String(n.nodeId ?? ""),
    nodeSegmentCount: n.nodeSegmentCount,
    initialCount: Math.min(n.initialCount, n.candidates.length),
    capturedWinnerIndex: n.capturedWinnerIndex ?? -1,
    candidates: n.candidates.map((c, ci) => {
      const end = c.trajOffset + c.trajLen
      if (c.trajOffset < 0 || end > payload.length) {
        throw new Error(
          `node ${ni} candidate ${ci}: trajectory [${c.trajOffset}, ${end}) outside payload of ${payload.length} samples`,
        )
      }
      return {
        hp: c.hp ?? {},
        solved: !!c.solved,
        iterations: c.iterations,
        maxIterations: c.maxIterations,
        solvedSegments: c.solvedSegments ?? -1,
        traj: payload.subarray(c.trajOffset, end),
      }
    }),
  }))
}
