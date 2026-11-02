/** App-wide shortcuts, written as "Mod+K" (Mod is Ctrl, or Cmd on a Mac), and the user's own choices. */

export interface KeyAction {
  id: string
  label: string
  /** The shipped combo. */
  key: string
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: "settings", label: "Settings", key: "Mod+," },
  { id: "palette", label: "Search chats and commands", key: "Mod+K" },
  { id: "find", label: "Find in this chat", key: "Mod+F" },
  { id: "new-chat", label: "New chat", key: "Mod+N" },
  { id: "sidebar", label: "Hide or show the sidebar", key: "Mod+B" },
  { id: "files", label: "Files", key: "Mod+P" },
  { id: "terminal", label: "Terminal", key: "Mod+`" },
]

const MODIFIERS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock"])

/**
 * The combo a key press makes, or undefined for a lone modifier. Letters are upper case and keep
 * Shift; a symbol that needs Shift to type is just the symbol. The backquote key is "`" whatever
 * the layout reports, so Mod+` survives keyboards that shift it.
 */
export interface KeyPress {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function comboOf(e: KeyPress): string | undefined {
  if (MODIFIERS.has(e.key)) return undefined
  const key = e.code === "Backquote" ? "`" : e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key
  return [
    e.ctrlKey || e.metaKey ? "Mod" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey && (key.length > 1 || /^[A-Z]$/.test(key)) ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join("+")
}

/** A combo is worth binding only with Mod or Alt (plain letters are typing) or as a function key. */
export function usableCombo(combo: string): boolean {
  return /^(Mod|Alt)\+/.test(combo) || /^(Shift\+)?F\d{1,2}$/.test(combo)
}

/** Combos the app or the webview already use for something else; binding them would take that away. */
export const RESERVED = new Set(["Mod+C", "Mod+V", "Mod+X", "Mod+A", "Mod+Z", "Mod+Y", "Mod+W", "Mod+Q", "Mod+R", "Mod+Enter"])

/** Each action's combo: the user's choice where there is one, else the shipped one. */
export function bindings(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, overrides[a.id] ?? a.key]))
}

/** Actions that share a combo, as combo → action ids (only combos with two or more). */
export function conflicts(bound: Record<string, string>): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const [id, combo] of Object.entries(bound)) if (combo) by.set(combo, [...(by.get(combo) ?? []), id])
  return new Map([...by].filter(([, ids]) => ids.length > 1))
}

/** Parse saved overrides, dropping anything that is not a known action with a usable combo. */
export function parseOverrides(text: string | undefined): Record<string, string> {
  if (!text) return {}
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== "object" || raw === null) return {}
    const ids = new Set(KEY_ACTIONS.map((a) => a.id))
    return Object.fromEntries(
      Object.entries(raw).filter(([id, combo]) => ids.has(id) && typeof combo === "string" && (combo === "" || usableCombo(combo))),
    ) as Record<string, string>
  } catch {
    return {}
  }
}

/** How a combo reads on this machine: Ctrl on Windows and Linux, ⌘ on a Mac. */
export function showCombo(combo: string, mac: boolean): string {
  return combo ? combo.replace(/^Mod\+/, mac ? "⌘" : "Ctrl+").replace(/Alt\+/, mac ? "⌥" : "Alt+") : "none"
}
