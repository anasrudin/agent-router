/**
 * Glass, as Ghostex draws its window: a backdrop (one of the built-in ones or the user's own
 * picture) behind translucent panels. The backdrop is blurred once, as a static layer, so the
 * panels only need transparency, not a live backdrop filter on every repaint.
 *
 * The choice is a per-machine convenience in localStorage; with storage blocked it simply lasts
 * until the window closes.
 */

export const BACKDROPS = [
  { id: "night", label: "Night" },
  { id: "ember", label: "Ember" },
  { id: "forest", label: "Forest" },
  { id: "graphite", label: "Graphite" },
] as const

type Store = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }

export interface AppearanceOptions {
  toggle: HTMLInputElement
  swatches: HTMLElement
  choose: HTMLButtonElement
  remove: HTMLButtonElement
  file: HTMLInputElement
  dim: HTMLInputElement
  store: Store
  report: (message: string) => void
}

/** A picture scaled to at most 2400px on its long side, as a JPEG data URL (small enough for storage). */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 2400 / Math.max(img.width, img.height))
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL("image/jpeg", 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("That file could not be read as a picture."))
    }
    img.src = url
  })
}

export function setupAppearance(o: AppearanceOptions) {
  const root = document.documentElement
  let image = o.store.get("backdrop-image") ?? ""

  const apply = () => {
    const on = o.store.get("glass") === "on"
    const backdrop = o.store.get("backdrop") ?? "night"
    root.dataset.glass = on ? "on" : "off"
    root.dataset.backdrop = backdrop
    root.style.setProperty("--backdrop-image", backdrop === "image" && image ? `url("${image}")` : "none")
    root.style.setProperty("--glass-dim", String(Number(o.store.get("glass-dim") ?? "55") / 100))
    o.toggle.checked = on
    o.dim.value = o.store.get("glass-dim") ?? "55"
    o.remove.hidden = !image
    for (const b of o.swatches.querySelectorAll<HTMLButtonElement>("button"))
      b.setAttribute("aria-pressed", String(b.dataset.backdrop === backdrop))
  }

  for (const b of [...BACKDROPS, ...(image ? [{ id: "image", label: "Your picture" }] : [])]) addSwatch(b.id, b.label)

  function addSwatch(id: string, label: string) {
    if (o.swatches.querySelector(`[data-backdrop="${id}"]`)) return
    const b = document.createElement("button")
    b.type = "button"
    b.className = `swatch-btn backdrop-${id}`
    b.dataset.backdrop = id
    b.title = label
    b.setAttribute("aria-label", label)
    b.addEventListener("click", () => {
      o.store.set("backdrop", id)
      o.store.set("glass", "on")
      apply()
    })
    o.swatches.append(b)
  }

  o.toggle.addEventListener("change", () => {
    o.store.set("glass", o.toggle.checked ? "on" : "off")
    apply()
  })
  o.dim.addEventListener("input", () => {
    o.store.set("glass-dim", o.dim.value)
    apply()
  })
  o.choose.addEventListener("click", () => o.file.click())
  o.file.addEventListener("change", () => {
    const file = o.file.files?.[0]
    o.file.value = ""
    if (!file) return
    shrink(file).then(
      (data) => {
        image = data
        o.store.set("backdrop-image", data)
        if (o.store.get("backdrop-image") !== data) o.report("The picture is too large to remember; it lasts until the window closes.")
        o.store.set("backdrop", "image")
        o.store.set("glass", "on")
        addSwatch("image", "Your picture")
        apply()
      },
      (e: unknown) => o.report(e instanceof Error ? e.message : String(e)),
    )
  })
  o.remove.addEventListener("click", () => {
    image = ""
    o.store.remove("backdrop-image")
    if (o.store.get("backdrop") === "image") o.store.set("backdrop", "night")
    o.swatches.querySelector('[data-backdrop="image"]')?.remove()
    apply()
  })
  apply()
  return {
    toggle() {
      o.store.set("glass", o.store.get("glass") === "on" ? "off" : "on")
      apply()
    },
  }
}
