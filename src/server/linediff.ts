import type { DiffLine } from "./protocol"

/**
 * A line diff of two texts (longest common subsequence), with unchanged runs cut to `context`
 * lines around each change; a cut is one "…" line. Config files are small, so O(n·m) is fine.
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n")
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n")
  const n = a.length
  const m = b.length
  // lcs[i * (m + 1) + j]: the common subsequence length of a[i..] and b[j..].
  const w = m + 1
  const lcs = new Int32Array((n + 1) * w)
  const at = (i: number, j: number) => lcs[i * w + j] as number
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      all.push({ k: " ", t: a[i] as string })
      i++
      j++
    } else if (i < n && (j === m || at(i + 1, j) >= at(i, j + 1))) all.push({ k: "-", t: a[i++] as string })
    else all.push({ k: "+", t: b[j++] as string })
  }
  const near = all.map(() => false)
  all.forEach((line, x) => {
    if (line.k === " ") return
    for (let y = Math.max(0, x - context); y <= Math.min(all.length - 1, x + context); y++) near[y] = true
  })
  const out: DiffLine[] = []
  all.forEach((line, x) => {
    if (near[x]) out.push(line)
    else if (out.at(-1)?.k !== "…") out.push({ k: "…", t: "" })
  })
  return out
}

/** How many lines a diff adds and removes. */
export function diffCounts(diff: DiffLine[]): { added: number; removed: number } {
  return { added: diff.filter((d) => d.k === "+").length, removed: diff.filter((d) => d.k === "-").length }
}
