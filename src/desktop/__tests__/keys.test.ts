import { describe, expect, test } from "bun:test"
import { bindings, comboOf, conflicts, parseOverrides, showCombo, usableCombo } from "../ui/keys"

const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, code = "") => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe("shortcuts", () => {
  test("a key press reads as a combo; Ctrl and Cmd are both Mod", () => {
    expect(comboOf(press("k", { ctrlKey: true }))).toBe("Mod+K")
    expect(comboOf(press("k", { metaKey: true }))).toBe("Mod+K")
    expect(comboOf(press("K", { ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+K")
    expect(comboOf(press("?", { ctrlKey: true, shiftKey: true }))).toBe("Mod+?")
    expect(comboOf(press("ArrowUp", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+ArrowUp")
    expect(comboOf(press("~", { ctrlKey: true }, "Backquote"))).toBe("Mod+`")
    expect(comboOf(press("Control", { ctrlKey: true }))).toBeUndefined()
    expect(comboOf(press("F2"))).toBe("F2")
  })

  test("plain typing cannot be a shortcut", () => {
    expect(usableCombo("K")).toBe(false)
    expect(usableCombo("Mod+K")).toBe(true)
    expect(usableCombo("Alt+J")).toBe(true)
    expect(usableCombo("F5")).toBe(true)
  })

  test("overrides replace shipped keys; conflicts are found; junk is dropped", () => {
    const bound = bindings(parseOverrides(JSON.stringify({ find: "Mod+K", nope: "Mod+J", files: "P", sidebar: "" })))
    expect(bound.find).toBe("Mod+K")
    expect(bound.files).toBe("Mod+P")
    expect(bound.sidebar).toBe("")
    expect(conflicts(bound).get("Mod+K")?.sort()).toEqual(["find", "palette"])
    expect(parseOverrides("{not json")).toEqual({})
  })

  test("combos read the way this machine names its keys", () => {
    expect(showCombo("Mod+,", false)).toBe("Ctrl+,")
    expect(showCombo("Mod+,", true)).toBe("⌘,")
    expect(showCombo("", false)).toBe("none")
  })
})
