/** Split a bill of `totalCents` across `people`, handing leftover cents to the first payers. */
export function splitBill(totalCents, people) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new RangeError("totalCents must be a non-negative integer")
  if (!Number.isInteger(people) || people < 1) throw new RangeError("people must be a positive integer")
  const base = Math.floor(totalCents / people)
  const leftover = totalCents % people
  return Array.from({ length: people }, (_, i) => base + (i <= leftover ? 1 : 0))
}
