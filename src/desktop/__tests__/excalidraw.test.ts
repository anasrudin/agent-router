import { describe, expect, test } from "bun:test"
import { parseDrawing, renderDrawing } from "../ui/excalidraw"

const scene = JSON.stringify({
  type: "excalidraw",
  elements: [
    { id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff" },
    { id: "label", type: "text", x: 10, y: 10, width: 80, height: 25, text: "API <server>", containerId: "box", fontSize: 20 },
    {
      id: "arrow",
      type: "arrow",
      x: 100,
      y: 25,
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [100, 0],
      ],
    },
    { id: "gone", type: "ellipse", x: 500, y: 500, width: 10, height: 10, isDeleted: true },
    { id: "evil", type: "rectangle", x: 0, y: 0, width: 1, height: 1, strokeColor: 'red" onload="x' },
  ],
})

describe("excalidraw drawings", () => {
  test("shapes, bound text, arrows; deleted ones skipped; labels for notes", () => {
    const els = parseDrawing(scene)
    expect(els?.map((e) => e.id)).toEqual(["box", "label", "arrow", "evil"])
    const d = renderDrawing(els ?? [])
    expect(d.svg).toStartWith('<svg class="drawing" viewBox="-24 -24 248 98"')
    expect(d.svg).toContain('<g class="ex-el" data-id="box"><rect')
    expect(d.svg).toContain("API &lt;server&gt;")
    expect(d.svg.match(/<path /g)?.length).toBe(2)
    expect(d.labels).toMatchObject({ box: "API <server>", arrow: "arrow" })
  })
  test("colours that are not plain values fall back; broken files are not drawings", () => {
    const d = renderDrawing(parseDrawing(scene) ?? [])
    expect(d.svg).not.toContain("onload")
    expect(parseDrawing("{nope")).toBeUndefined()
    expect(parseDrawing('{"elements":3}')).toBeUndefined()
  })
})
