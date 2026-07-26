/**
 * PROTOTYPE: global multi-net wavefront router with negotiated congestion.
 *
 * Everything else in this campaign routes nets one at a time inside a
 * decomposed mesh, which is why a node can be handed one net too many and no
 * local remedy can fix it (see experiments/drop-one.ts: 40/40 doomed nodes are
 * rescued by removing a single connection). This routes ALL nets against one
 * shared cost field and lets contention resolve globally - the PathFinder
 * scheme (Ebeling 1995) every FPGA router uses.
 *
 * Deliberately independent of the pipeline: it reads the same SimpleRouteJson
 * and emits SimplifiedPcbTrace[], so the existing DRC evaluator scores it.
 *
 * Success criterion is QUALITY, not speed: a JS wavefront over a multi-million
 * cell grid is slow by construction. If DRC is competitive, the algorithm is
 * also the one shape that maps onto a GPU (one resident cost field, one kernel
 * for all nets, no divergence).
 */

export type RouterOptions = {
  cellSize?: number
  maxIterations?: number
  viaCost?: number
  historyIncrement?: number
  presentGrowth?: number
  /** ceiling on the congestion multiplier, keeps detours bounded */
  congestionCap?: number
  verbose?: boolean
}

type Grid = {
  nx: number
  ny: number
  nz: number
  cellSize: number
  minX: number
  minY: number
  /** per-cell static blockage, one Uint8Array per layer */
  blocked: Uint8Array[]
  /** obstacle id occupying a cell, so a net may enter its own pads */
  owner: Int32Array[]
}

type Net = {
  index: number
  name: string
  width: number
  terminals: Array<{ x: number; y: number; z: number }>
  /** cells currently used by this net's tree */
  cells: number[]
}

const layerToZ = (layer: string, layerCount: number): number => {
  if (layer === "top") return 0
  if (layer === "bottom") return layerCount - 1
  const m = layer.match(/(\d+)/)
  return m ? Math.min(layerCount - 1, Number(m[1])) : 0
}

const zToLayer = (z: number, layerCount: number): string =>
  z === 0 ? "top" : z === layerCount - 1 ? "bottom" : `inner${z}`

export const buildGrid = (srj: any, cellSize: number): Grid => {
  const { minX, minY, maxX, maxY } = srj.bounds
  const nz = srj.layerCount ?? 2
  const nx = Math.ceil((maxX - minX) / cellSize) + 1
  const ny = Math.ceil((maxY - minY) / cellSize) + 1
  const blocked: Uint8Array[] = []
  const owner: Int32Array[] = []
  for (let z = 0; z < nz; z++) {
    blocked.push(new Uint8Array(nx * ny))
    owner.push(new Int32Array(nx * ny).fill(-1))
  }

  const clearance = srj.minTraceWidth ?? 0.1
  const halfTrace = (srj.minTraceWidth ?? 0.1) / 2

  srj.obstacles?.forEach((ob: any, obIndex: number) => {
    const pad = halfTrace + clearance / 2
    const halfW = (ob.width ?? 0) / 2 + pad
    const halfH = (ob.height ?? 0) / 2 + pad
    const zs: number[] = (ob.layers ?? ["top"]).map((l: string) =>
      layerToZ(l, nz),
    )
    const x0 = Math.max(0, Math.floor((ob.center.x - halfW - minX) / cellSize))
    const x1 = Math.min(nx - 1, Math.ceil((ob.center.x + halfW - minX) / cellSize))
    const y0 = Math.max(0, Math.floor((ob.center.y - halfH - minY) / cellSize))
    const y1 = Math.min(ny - 1, Math.ceil((ob.center.y + halfH - minY) / cellSize))
    for (const z of zs) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          const idx = iy * nx + ix
          blocked[z]![idx] = 1
          owner[z]![idx] = obIndex
        }
      }
    }
  })

  return { nx, ny, nz, cellSize, minX, minY, blocked, owner }
}

/** Minimal binary heap keyed by cost. */
class Heap {
  private cost: Float64Array
  private item: Int32Array
  private n = 0
  constructor(capacity: number) {
    this.cost = new Float64Array(capacity)
    this.item = new Int32Array(capacity)
  }
  get size() {
    return this.n
  }
  clear() {
    this.n = 0
  }
  push(c: number, v: number) {
    if (this.n >= this.item.length) {
      const cost = new Float64Array(this.item.length * 2)
      const item = new Int32Array(this.item.length * 2)
      cost.set(this.cost)
      item.set(this.item)
      this.cost = cost
      this.item = item
    }
    let i = this.n++
    this.cost[i] = c
    this.item[i] = v
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.cost[p]! <= this.cost[i]!) break
      ;[this.cost[p], this.cost[i]] = [this.cost[i]!, this.cost[p]!]
      ;[this.item[p], this.item[i]] = [this.item[i]!, this.item[p]!]
      i = p
    }
  }
  pop(): { cost: number; item: number } {
    const top = { cost: this.cost[0]!, item: this.item[0]! }
    this.n--
    if (this.n > 0) {
      this.cost[0] = this.cost[this.n]!
      this.item[0] = this.item[this.n]!
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.n && this.cost[l]! < this.cost[m]!) m = l
        if (r < this.n && this.cost[r]! < this.cost[m]!) m = r
        if (m === i) break
        ;[this.cost[m], this.cost[i]] = [this.cost[i]!, this.cost[m]!]
        ;[this.item[m], this.item[i]] = [this.item[i]!, this.item[m]!]
        i = m
      }
    }
    return top
  }
}

export const routeBoard = (srj: any, opts: RouterOptions = {}) => {
  const cellSize = opts.cellSize ?? 0.1
  const maxIterations = opts.maxIterations ?? 8
  const viaCost = opts.viaCost ?? 12
  const historyIncrement = opts.historyIncrement ?? 1
  const presentGrowth = opts.presentGrowth ?? 1.5
  const congestionCap = opts.congestionCap ?? 12

  const grid = buildGrid(srj, cellSize)
  const { nx, ny, nz } = grid
  const planeSize = nx * ny
  const totalCells = planeSize * nz

  const nets: Net[] = (srj.connections ?? []).map((c: any, i: number) => ({
    index: i,
    name: c.name,
    width: c.width ?? srj.minTraceWidth ?? 0.1,
    terminals: (c.pointsToConnect ?? []).map((p: any) => ({
      x: p.x,
      y: p.y,
      z: layerToZ(p.layer, nz),
    })),
    cells: [],
  }))

  /**
   * 99% of terminals sit ON pads, which are blocked obstacles, so a net must be
   * allowed through the specific pads its own terminals occupy. A fixed carve
   * radius does not work (pads inflate to ~1mm, far beyond any small disc), so
   * use the per-cell obstacle owner recorded at grid build time and let a net
   * pass through exactly the obstacles holding its terminals.
   */
  const ownedObstacles: Array<Set<number>> = []
  const isBlockedFor = (net: Net, ix: number, iy: number, z: number): boolean => {
    if (!grid.blocked[z]![iy * nx + ix]) return false
    const ob = grid.owner[z]![iy * nx + ix]!
    return !(ob >= 0 && ownedObstacles[net.index]!.has(ob))
  }

  const toCell = (x: number, y: number, z: number) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.round((x - grid.minX) / cellSize)))
    const iy = Math.min(ny - 1, Math.max(0, Math.round((y - grid.minY) / cellSize)))
    return z * planeSize + iy * nx + ix
  }
  const cellXY = (cell: number) => {
    const z = Math.floor(cell / planeSize)
    const rem = cell - z * planeSize
    const iy = Math.floor(rem / nx)
    const ix = rem - iy * nx
    return { x: grid.minX + ix * cellSize, y: grid.minY + iy * cellSize, z, ix, iy }
  }

  // which obstacles does each net's own terminals sit on / next to?
  for (const net of nets) {
    const owned = new Set<number>()
    for (const t of net.terminals) {
      const tx = Math.round((t.x - grid.minX) / cellSize)
      const ty = Math.round((t.y - grid.minY) / cellSize)
      const probe = Math.max(1, Math.round(0.15 / cellSize))
      for (let dy = -probe; dy <= probe; dy++) {
        for (let dx = -probe; dx <= probe; dx++) {
          const jx = tx + dx
          const jy = ty + dy
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue
          const ob = grid.owner[t.z]![jy * nx + jx]!
          if (ob >= 0) owned.add(ob)
        }
      }
    }
    ownedObstacles[net.index] = owned
  }

  // congestion state
  const usage = new Int32Array(totalCells)
  const history = new Float64Array(totalCells).fill(1)
  const occupant = new Int32Array(totalCells).fill(-1)

  /**
   * Minimum legal centre-to-centre spacing between two nets, in cells. Two
   * traces are legal at traceWidth + clearance apart, so anything strictly
   * closer than that is a violation. Stamping a halo and counting halo overlap
   * (the first attempt) can never converge: traces at exactly the legal spacing
   * still share halo cells, so overuse is structurally non-zero forever.
   */
  const minSpacingCells = Math.max(
    1,
    Math.round(((srj.minTraceWidth ?? 0.1) * 2) / cellSize),
  )

  /** Occupancy is recorded on trace CENTRES only. */
  const stampNet = (net: Net, add: boolean) => {
    for (const cell of net.cells) {
      if (add) {
        usage[cell]!++
        if (occupant[cell] === -1) occupant[cell] = net.index
      } else {
        usage[cell]!--
        if (usage[cell]! <= 0) occupant[cell] = -1
      }
    }
  }

  /** How many OTHER nets' centres sit closer than the legal spacing. */
  const neighbourConflicts = (
    netIndex: number,
    ix: number,
    iy: number,
    z: number,
  ): number => {
    let conflicts = 0
    const r = minSpacingCells - 1
    for (let dy = -r; dy <= r; dy++) {
      const jy = iy + dy
      if (jy < 0 || jy >= ny) continue
      for (let dx = -r; dx <= r; dx++) {
        const jx = ix + dx
        if (jx < 0 || jx >= nx) continue
        const idx = z * planeSize + jy * nx + jx
        if (usage[idx]! > 0 && occupant[idx] !== netIndex) conflicts += usage[idx]!
      }
    }
    return conflicts
  }

  const dist = new Float64Array(totalCells)
  const prev = new Int32Array(totalCells)
  const visitStamp = new Int32Array(totalCells)
  let stamp = 0
  const heap = new Heap(1 << 16)

  let presentFactor = 0.5

  /** Route one net: multi-source wavefront from its tree to the nearest unconnected terminal. */
  const routeNet = (net: Net): boolean => {
    if (net.terminals.length < 2) return true
    net.cells = []
    const connected = new Set<number>()
    const start = toCell(net.terminals[0]!.x, net.terminals[0]!.y, net.terminals[0]!.z)
    connected.add(start)
    net.cells.push(start)

    for (let t = 1; t < net.terminals.length; t++) {
      const target = toCell(net.terminals[t]!.x, net.terminals[t]!.y, net.terminals[t]!.z)
      if (connected.has(target)) continue

      stamp++
      heap.clear()
      for (const c of connected) {
        dist[c] = 0
        prev[c] = -1
        visitStamp[c] = stamp
        heap.push(0, c)
      }

      let found = -1
      while (heap.size > 0) {
        const { cost, item } = heap.pop()
        if (cost > dist[item]!) continue
        if (item === target) {
          found = item
          break
        }
        const { ix, iy, z } = cellXY(item)
        // in-plane 8-neighbourhood plus layer changes
        for (let d = 0; d < 10; d++) {
          let jx = ix
          let jy = iy
          let jz = z
          let stepCost = 0
          if (d < 8) {
            const dx = [1, -1, 0, 0, 1, 1, -1, -1][d]!
            const dy = [0, 0, 1, -1, 1, -1, 1, -1][d]!
            jx += dx
            jy += dy
            stepCost = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
          } else {
            jz = d === 8 ? z - 1 : z + 1
            stepCost = viaCost
          }
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny || jz < 0 || jz >= nz) continue
          const nIdx = jz * planeSize + jy * nx + jx
          // static blockage, unless this obstacle belongs to our own net's pad
          if (isBlockedFor(net, jx, jy, jz) && nIdx !== target) continue
          const conflicts = neighbourConflicts(net.index, jx, jy, jz)
          // Cap the congestion multiplier. Uncapped (1 + p*conflicts*history)
          // reaches >200 within a few iterations, at which point a 200-cell
          // detour is cheaper than crossing one congested cell - the router
          // then produces 4x the necessary trace length.
          const congestion =
            conflicts > 0
              ? 1 +
                Math.min(
                  congestionCap,
                  presentFactor * conflicts * history[nIdx]!,
                )
              : 1
          const nd = dist[item]! + stepCost * congestion
          if (visitStamp[nIdx] !== stamp || nd < dist[nIdx]!) {
            visitStamp[nIdx] = stamp
            dist[nIdx] = nd
            prev[nIdx] = item
            heap.push(nd, nIdx)
          }
        }
      }

      if (found < 0) return false
      let cur = found
      while (cur !== -1 && !connected.has(cur)) {
        connected.add(cur)
        net.cells.push(cur)
        cur = prev[cur]!
      }
    }
    return true
  }

  const t0 = Date.now()
  let iteration = 0
  let unroutable = 0
  for (; iteration < maxIterations; iteration++) {
    for (const net of nets) {
      if (net.cells.length) stampNet(net, false)
    }
    unroutable = 0
    for (const net of nets) {
      if (!routeNet(net)) unroutable++
      stampNet(net, true)
    }
    // overuse = cells carrying more than one net
    let overused = 0
    for (const net of nets) {
      for (const cell of net.cells) {
        const { ix, iy, z } = cellXY(cell)
        if (neighbourConflicts(net.index, ix, iy, z) > 0) {
          overused++
          history[cell]! += historyIncrement
        }
      }
    }
    if (opts.verbose) {
      let len = 0
      for (const net of nets) {
        for (let i = 1; i < net.cells.length; i++) {
          const a = cellXY(net.cells[i - 1]!)
          const b = cellXY(net.cells[i]!)
          if (a.z === b.z) len += Math.hypot(b.x - a.x, b.y - a.y)
        }
      }
      console.log(
        `  iter ${iteration}: overused ${overused}, unroutable ${unroutable}, length ${len.toFixed(0)}mm, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      )
    }
    if (overused === 0 && unroutable === 0) break
    presentFactor *= presentGrowth
  }

  // emit traces
  const traces = nets
    .filter((n) => n.cells.length > 1)
    .map((net) => {
      const pts = net.cells.map((c) => cellXY(c))
      const route: any[] = []
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!
        if (i > 0 && pts[i - 1]!.z !== p.z) {
          route.push({
            route_type: "via",
            x: p.x,
            y: p.y,
            from_layer: zToLayer(pts[i - 1]!.z, nz),
            to_layer: zToLayer(p.z, nz),
          })
        }
        route.push({
          route_type: "wire",
          x: p.x,
          y: p.y,
          width: net.width,
          layer: zToLayer(p.z, nz),
        })
      }
      return {
        type: "pcb_trace",
        pcb_trace_id: `wavefront_${net.name}`,
        connection_name: net.name,
        route,
      }
    })

  return {
    traces,
    iterations: iteration + 1,
    unroutable,
    wallS: (Date.now() - t0) / 1000,
    gridCells: totalCells,
  }
}
