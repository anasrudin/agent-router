/** Version strings as CLIs print them. Pure, so the desktop UI can use it too. */

/** The first x.y.z in a version line ("2.1.316 (Claude Code)" → "2.1.316"). */
export function semver(text: string | undefined): string | undefined {
  return text?.match(/\d+\.\d+\.\d+/)?.[0]
}

/** True when `a` is an older x.y.z than `b`. */
export function olderThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number)
  const y = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}
