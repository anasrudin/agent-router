/**
 * Excalidraw drawings (.excalidraw), drawn as SVG without the Excalidraw app: rectangles,
 * diamonds, ellipses, lines, arrows, freehand strokes and text, each a <g data-id> that can be
 * clicked to leave a note on it. Strokes are clean rather than hand-drawn.
 */
interface El {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: string
  opacity?: number
  points?: [number, number][]
  text?: string
  fontSize?: number
  textAlign?: string
  containerId?: string | null
  isDeleted?: boolean
  roundness?: unknown
  endArrowhead?: string | null
  startArrowhead?: string | null
}

const esc = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
/** Colours come from the drawing; only plain colour values pass. */
const color = (c: unknown, fallback: string) => (typeof c === "string" && /^(#[0-9a-f]{3,8}|[a-z]+|transparent)$/i.test(c) ? c : fallback)
const num = (n: unknown, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? n : fallback)

export interface Drawing {
  svg: string
  /** A name per element, for notes: its text, the text bound to it, or its kind. */
  labels: Record<string, string>
}

export function parseDrawing(source: string): El[] | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return undefined
  }
  const els = (raw as { elements?: unknown })?.elements
  if (!Array.isArray(els)) return undefined
  return (els as El[]).filter((e) => e && typeof e === "object" && !e.isDeleted && typeof e.type === "string" && typeof e.id === "string")
}

function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): string {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const p = (d: number) => `${(x2 - size * Math.cos(a + d)).toFixed(1)},${(y2 - size * Math.sin(a + d)).toFixed(1)}`
  return `M${p(0.45)} L${x2.toFixed(1)},${y2.toFixed(1)} L${p(-0.45)}`
}

export function renderDrawing(els: El[]): Drawing {
  const labels: Record<string, string> = {}
  const bound = new Map<string, string>()
  for (const e of els) if (e.type === "text" && e.containerId && e.text) bound.set(e.containerId, e.text)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const parts: string[] = []
  for (const e of els) {
    const x = num(e.x)
    const y = num(e.y)
    const w = num(e.width)
    const h = num(e.height)
    const pts = Array.isArray(e.points) ? e.points.map(([px, py]) => [x + num(px), y + num(py)] as const) : []
    const xs = pts.length ? pts.map((p) => p[0]) : [x, x + w]
    const ys = pts.length ? pts.map((p) => p[1]) : [y, y + h]
    minX = Math.min(minX, ...xs)
    minY = Math.min(minY, ...ys)
    maxX = Math.max(maxX, ...xs)
    maxY = Math.max(maxY, ...ys)
    const stroke = color(e.strokeColor, "#1e1e1e")
    const fill = e.backgroundColor && e.backgroundColor !== "transparent" ? color(e.backgroundColor, "none") : "none"
    const sw = Math.max(0.5, num(e.strokeWidth, 1.5))
    const dash = e.strokeStyle === "dashed" ? ' stroke-dasharray="8 6"' : e.strokeStyle === "dotted" ? ' stroke-dasharray="2 5"' : ""
    const common = `stroke="${stroke}" stroke-width="${sw}" fill="${fill}"${dash}${e.fillStyle === "hachure" || e.fillStyle === "cross-hatch" ? ' fill-opacity="0.35"' : ""}`
    let shape = ""
    if (e.type === "rectangle" || e.type === "frame") {
      const r = e.roundness ? Math.min(w, h) * 0.12 : 0
      shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r.toFixed(1)}" ${common}/>`
    } else if (e.type === "ellipse") shape = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${common}/>`
    else if (e.type === "diamond")
      shape = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${common}/>`
    else if ((e.type === "line" || e.type === "arrow" || e.type === "freedraw") && pts.length > 1) {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")
      shape = `<path d="${d}" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round"${dash}/>`
      const last = pts.at(-1) as readonly [number, number]
      const prev = pts.at(-2) as readonly [number, number]
      if (e.type === "arrow" && e.endArrowhead !== null)
        shape += `<path d="${arrowHead(prev[0], prev[1], last[0], last[1], 12)}" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`
      if (e.type === "arrow" && e.startArrowhead) {
        const [a, b] = [pts[1] as readonly [number, number], pts[0] as readonly [number, number]]
        shape += `<path d="${arrowHead(a[0], a[1], b[0], b[1], 12)}" stroke="${stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`
      }
    } else if (e.type === "text" && e.text) {
      const size = num(e.fontSize, 20)
      const anchor = e.textAlign === "center" ? "middle" : e.textAlign === "right" ? "end" : "start"
      const tx = anchor === "middle" ? x + w / 2 : anchor === "end" ? x + w : x
      const lines = e.text.split("\n")
      shape = `<text x="${tx}" y="${y + size}" font-size="${size}" text-anchor="${anchor}" fill="${stroke}">${lines
        .map((l, i) => `<tspan x="${tx}" dy="${i ? size * 1.25 : 0}">${esc(l)}</tspan>`)
        .join("")}</text>`
    }
    if (!shape) continue
    labels[e.id] = (bound.get(e.id) ?? e.text ?? e.type).replace(/\s+/g, " ").trim().slice(0, 80) || e.type
    const rot = num(e.angle) ? ` transform="rotate(${((num(e.angle) * 180) / Math.PI).toFixed(2)} ${x + w / 2} ${y + h / 2})"` : ""
    const opacity = e.opacity !== undefined && num(e.opacity, 100) < 100 ? ` opacity="${num(e.opacity, 100) / 100}"` : ""
    parts.push(`<g class="ex-el" data-id="${esc(e.id)}"${rot}${opacity}>${shape}</g>`)
  }
  if (!parts.length) return { svg: "", labels }
  const pad = 24
  const vb = `${(minX - pad).toFixed(0)} ${(minY - pad).toFixed(0)} ${(maxX - minX + pad * 2).toFixed(0)} ${(maxY - minY + pad * 2).toFixed(0)}`
  return {
    svg: `<svg class="drawing" viewBox="${vb}" role="img" aria-label="Drawing" font-family="Virgil, Segoe Print, Comic Sans MS, sans-serif">${parts.join("")}</svg>`,
    labels,
  }
}
