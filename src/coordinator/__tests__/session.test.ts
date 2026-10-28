import { describe, expect, test } from "bun:test"
import { fakeRegistry, report, testSession } from "../../test-support"
import { delegate } from "../delegate"
import { Brief } from "../protocol"
import { Semaphore } from "../session"

describe("Semaphore", () => {
  test("a newcomer cannot take a slot that is being handed to a waiter", async () => {
    const sem = new Semaphore(1)
    let active = 0
    let peak = 0
    const job = () =>
      sem.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await Bun.sleep(5)
        active -= 1
      })
    const first = job()
    const waiter = job()
    await first
    // Released a moment ago: the waiter owns the slot even though it has not resumed yet.
    const newcomer = job()
    await Promise.all([waiter, newcomer])
    expect(peak).toBe(1)
  })
})

describe("per-provider slots", () => {
  test("delegations on one backend queue at max_parallel_per_provider", async () => {
    const backends = fakeRegistry({ gemini: [{ text: report("done") }, { text: report("done") }] })
    let running = 0
    let peak = 0
    const original = backends.gemini.run
    backends.gemini.run = async function* (o) {
      running += 1
      peak = Math.max(peak, running)
      await Bun.sleep(20)
      yield* original(o)
      running -= 1
    }
    const session = testSession(backends, { limits: { max_parallel_per_provider: 1 } })
    const brief = Brief.parse({ task: "Find it.", why: "w", acceptance: ["a"] })
    const results = await Promise.all([1, 2].map(() => delegate(session, { taskClass: "search.codebase", brief })))
    expect(results.map((r) => r.status)).toEqual(["done", "done"])
    expect(peak).toBe(1)
  })
})
