import { dlopen, FFIType, suffix } from "bun:ffi"
import path from "node:path"

/**
 * bun:ffi driver for the Rust A01 port (native/hdastar): one-shot solve plus
 * the stateful incremental API used by the portfolio integration.
 */

const lib = dlopen(
  path.resolve(import.meta.dir, `target/release/libhdastar.${suffix}`),
  {
    a01_solve: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    a01_create: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
    a01_step: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    a01_step_packed: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
    a01_max_iterations: { args: [FFIType.u64], returns: FFIType.u64 },
    a01_error: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    a01_state: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    a01_routes: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    a01_destroy: { args: [FFIType.u64], returns: FFIType.void },
  },
)

const OUT_CAP = 64 * 1024 * 1024
const outBuf = new BigUint64Array(OUT_CAP / 8)
const stateBuf = new BigUint64Array(4096)

export type NativeA01Result = {
  solved: boolean
  failed: boolean
  error: string | null
  iterations: number
  routes: unknown[]
}

export const solveA01Native = (input: Record<string, unknown>): NativeA01Result => {
  const inputJson = new TextEncoder().encode(JSON.stringify(input))
  const written = lib.symbols.a01_solve(
    inputJson,
    inputJson.byteLength,
    outBuf,
    OUT_CAP,
  ) as unknown as bigint
  const n = Number(written)
  if (n === -1) throw new Error("a01_solve: output buffer too small")
  if (n < 0) throw new Error(`a01_solve failed with code ${n}`)
  const outBytes = new Uint8Array(outBuf.buffer, 0, n)
  return JSON.parse(new TextDecoder().decode(outBytes))
}

const readJson = (ptr: BigUint64Array, n: number) =>
  JSON.parse(new TextDecoder().decode(new Uint8Array(ptr.buffer, 0, n)))

export class NativeA01Session {
  private handle: bigint

  constructor(input: Record<string, unknown>) {
    const inputJson = new TextEncoder().encode(JSON.stringify(input))
    this.handle = lib.symbols.a01_create(
      inputJson,
      inputJson.byteLength,
    ) as unknown as bigint
    if (this.handle === 0n) {
      throw new Error("a01_create failed (input rejected)")
    }
  }

  step(n: number): number {
    return lib.symbols.a01_step(this.handle, BigInt(n)) as number
  }

  /** Packed step: returns { status: 1|running 2|solved 3|failed, solvedSegments } */
  stepPacked(n: number): { status: number; solvedSegments: number } {
    const packed = lib.symbols.a01_step_packed(this.handle, BigInt(n)) as bigint
    const failed = (packed & (1n << 63n)) !== 0n
    const solved = (packed & (1n << 62n)) !== 0n
    return {
      status: failed ? 3 : solved ? 2 : 1,
      solvedSegments: Number(packed & 0x3fffffffffffffffn),
    }
  }

  maxIterations(): number {
    return Number(lib.symbols.a01_max_iterations(this.handle) as bigint)
  }

  error(): string | null {
    const n = Number(
      lib.symbols.a01_error(this.handle, stateBuf, 4 * 4096) as unknown as bigint,
    )
    if (n <= 0) return null
    return new TextDecoder().decode(new Uint8Array(stateBuf.buffer, 0, n))
  }

  state(): { state: number; iterations: number; solvedSegments: number; maxIterations: number; error: string | null } {
    const n = Number(
      lib.symbols.a01_state(this.handle, stateBuf, 4 * 4096) as unknown as bigint,
    )
    if (n < 0) throw new Error(`a01_state failed with code ${n}`)
    return readJson(stateBuf, n)
  }

  routes(): unknown[] {
    const n = Number(
      lib.symbols.a01_routes(this.handle, outBuf, OUT_CAP) as unknown as bigint,
    )
    if (n === -1) throw new Error("a01_routes: output buffer too small")
    if (n < 0) throw new Error(`a01_routes failed with code ${n}`)
    return readJson(outBuf, n)
  }

  destroy(): void {
    if (this.handle !== 0n) {
      lib.symbols.a01_destroy(this.handle)
      this.handle = 0n
    }
  }
}
