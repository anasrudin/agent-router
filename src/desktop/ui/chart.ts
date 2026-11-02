const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)

/**
 * A small chart from a ```chart block in a reply, drawn as inline SVG:
 *   {"type": "bar" | "line", "title": "…", "labels": ["a", "b"], "series": [{"name": "…", "values": [1, 2]}]}
 * Anything that does not parse as that shape stays a code block. Colours come from the theme
 * (classes series-0 to series-3), labels are escaped like all model output.
 */
export interface ChartSpec {
  type: "bar" | "line"
  title?: string
  labels: string[]
  series: { name: string; values: number[] }[]
}

export function parseChart(source: string): ChartSpec | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return undefined
  }
  const r = raw as Record<string, unknown>
  if (!r || (r.type !== "bar" && r.type !== "line") || !Array.isArray(r.labels) || !Array.isArray(r.series)) return undefined
  const labels = r.labels.map(String).slice(0, 40)
  const series = (r.series as Record<string, unknown>[])
    .filter((s) => s && Array.isArray(s.values))
    .slice(0, 4)
    .map((s) => ({ name: String(s.name ?? ""), values: (s.values as unknown[]).slice(0, labels.length).map((v) => Number(v) || 0) }))
  if (!labels.length || !series.length) return undefined
  return { type: r.type, title: typeof r.title === "string" ? r.title : undefined, labels, series }
}

const W = 560
const H = 240
const PAD = { top: 16, right: 12, bottom: 40, left: 44 }

/** A round step for the axis: 1, 2 or 5 times a power of ten. */
function niceMax(max: number): number {
  if (max <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 5, 10]) if (m * pow >= max) return m * pow
  return 10 * pow
}

const fmt = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${+n.toFixed(2)}`

export function renderChart(spec: ChartSpec): string {
  const max = niceMax(Math.max(0, ...spec.series.flatMap((s) => s.values)))
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / max) * plotH
  const band = plotW / spec.labels.length
  const parts: string[] = []
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    parts.push(
      `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`,
    )
  }
  spec.labels.forEach((label, i) => {
    const short = label.length > 12 ? `${label.slice(0, 11)}…` : label
    parts.push(
      `<text class="axis" x="${PAD.left + band * (i + 0.5)}" y="${H - PAD.bottom + 16}" text-anchor="middle">${escapeHtml(short)}</text>`,
    )
  })
  spec.series.forEach((s, si) => {
    if (spec.type === "bar") {
      const barW = (band * 0.7) / spec.series.length
      s.values.forEach((v, i) => {
        const x = PAD.left + band * i + band * 0.15 + barW * si
        parts.push(
          `<rect class="series-${si}" x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${(PAD.top + plotH - y(v)).toFixed(1)}" rx="2"><title>${escapeHtml(`${s.name ? `${s.name}, ` : ""}${spec.labels[i]}: ${v}`)}</title></rect>`,
        )
      })
    } else {
      const points = s.values.map((v, i) => `${(PAD.left + band * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
      parts.push(`<polyline class="series-${si}" points="${points}"/>`)
      s.values.forEach((v, i) => {
        parts.push(
          `<circle class="series-${si}" cx="${(PAD.left + band * (i + 0.5)).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>${escapeHtml(`${s.name ? `${s.name}, ` : ""}${spec.labels[i]}: ${v}`)}</title></circle>`,
        )
      })
    }
  })
  const legend =
    spec.series.length > 1 || spec.series[0]?.name
      ? `<figcaption class="chart-legend">${spec.series.map((s, i) => `<span><i class="swatch series-${i}"></i>${escapeHtml(s.name)}</span>`).join("")}</figcaption>`
      : ""
  const title = spec.title ? `<div class="chart-title">${escapeHtml(spec.title)}</div>` : ""
  const label = escapeHtml(spec.title ?? `${spec.type} chart`)
  return `<figure class="chart chart-${spec.type}">${title}<svg class="chart-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${parts.join("")}</svg>${legend}</figure>`
}
