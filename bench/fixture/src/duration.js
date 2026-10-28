const UNITS = { h: 3600, m: 60, s: 1 }

/** Parse durations like "1h30m", "45s" or "2h" into seconds. */
export function parseDuration(text) {
  const parts = [...text.matchAll(/(\d+)([hms])/g)]
  if (parts.length === 0) throw new SyntaxError(`not a duration: ${text}`)
  return parts.reduce((sum, [, n, unit]) => sum + n * UNITS[unit], 0)
}
