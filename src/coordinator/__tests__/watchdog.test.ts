import { describe, expect, test } from "bun:test"
import { stableStringify, Watchdog, type WatchdogTrip } from "../watchdog"

const call = (input: unknown) => ({ type: "tool_call" as const, name: "Bash", input })

describe("Watchdog", () => {
  test("fingerprints ignore key order", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }))
  })

  test("only consecutive identical calls count", () => {
    const trips: WatchdogTrip[] = []
    const dog = new Watchdog({ stallMs: 60_000, maxIdenticalToolCalls: 3, onTrip: (t) => trips.push(t) })
    for (const input of [{ cmd: "ls" }, { cmd: "ls" }, { cmd: "pwd" }, { cmd: "ls" }, { cmd: "ls" }]) dog.observe(call(input))
    expect(trips).toEqual([])
    dog.observe(call({ cmd: "ls" }))
    expect(trips.map((t) => t.kind)).toEqual(["tool_loop"])
    dog.observe(call({ cmd: "ls" }))
    expect(trips).toHaveLength(1)
    dog.stop()
  })

  test("any event resets the stall timer", async () => {
    const trips: WatchdogTrip[] = []
    const dog = new Watchdog({ stallMs: 80, maxIdenticalToolCalls: 5, onTrip: (t) => trips.push(t) })
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(40)
      dog.observe({ type: "text", text: "." })
    }
    expect(trips).toEqual([])
    await Bun.sleep(120)
    expect(trips.map((t) => t.kind)).toEqual(["stalled"])
  })

  test("events after stop() do not re-arm it", async () => {
    const trips: WatchdogTrip[] = []
    const dog = new Watchdog({ stallMs: 30, maxIdenticalToolCalls: 5, onTrip: (t) => trips.push(t) })
    dog.stop()
    dog.observe({ type: "text", text: "late" })
    await Bun.sleep(80)
    expect(trips).toEqual([])
  })
})
