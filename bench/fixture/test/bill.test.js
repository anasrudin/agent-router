import assert from "node:assert/strict"
import { test } from "node:test"
import { splitBill } from "../src/bill.js"

test("even split", () => assert.deepEqual(splitBill(900, 3), [300, 300, 300]))
test("leftover cents go to the first payers", () => assert.deepEqual(splitBill(1000, 3), [334, 333, 333]))
test("total is preserved", () => {
  for (const [t, p] of [
    [1, 4],
    [101, 7],
    [99999, 13],
  ])
    assert.equal(
      splitBill(t, p).reduce((a, b) => a + b, 0),
      t,
    )
})
test("rejects bad input", () => {
  assert.throws(() => splitBill(-1, 2), RangeError)
  assert.throws(() => splitBill(10, 0), RangeError)
})
