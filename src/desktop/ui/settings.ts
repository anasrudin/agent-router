import type { BackendOptions } from "../../backends/Backend"
import type { ProviderId, Tier } from "../../config/schema"
import type { ClientMessage, ServerMessage, SettingsScope, SettingsSnapshot, SettingsValues } from "../../server/protocol"
import { escapeHtml } from "./markdown"

const PROVIDERS: ProviderId[] = ["claude", "gemini", "openai"]
const TIERS: Tier[] = ["fast", "standard", "deep"]
const LABEL: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini", openai: "Codex" }
const CUSTOM = "__custom__"

type Send = (message: ClientMessage) => void

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** The Models dialog: per backend and tier, which model and reasoning effort to use. */
export function createSettings(send: Send, workspace: () => string, notify: (message: string) => void) {
  const dialog = $<HTMLDialogElement>("settings")
  const body = $<HTMLDivElement>("settings-body")
  const status = $<HTMLSpanElement>("settings-status")
  const saveButton = $<HTMLButtonElement>("settings-save")
  let options: Record<ProviderId, BackendOptions> | undefined
  let testCounter = 0
  const pendingTests = new Map<string, HTMLElement>()

  function setStatus(text: string, kind: "" | "error" | "warn" = "") {
    status.textContent = text
    status.className = kind ? `muted ${kind}` : "muted"
  }

  function open() {
    if (!workspace()) {
      notify("Choose a workspace folder first: model settings can be saved per project.")
      return
    }
    body.innerHTML = '<p class="muted">Loading models…</p>'
    saveButton.disabled = true
    setStatus("Changes apply from the next request.")
    dialog.showModal()
    send({ type: "settings.get", workspace: workspace() })
  }

  function modelSelect(provider: ProviderId, tier: Tier, current: string): HTMLElement {
    const cell = document.createElement("div")
    cell.className = "model-cell"
    const select = document.createElement("select")
    select.name = `${provider}.${tier}.model`
    select.setAttribute("aria-label", `${LABEL[provider]} ${tier} model`)
    const models = options?.[provider].models ?? []
    const known = models.some((m) => m.id === current)
    for (const m of models) select.add(new Option(m.description ? `${m.id} — ${m.description}` : m.id, m.id))
    select.add(new Option("Other model id…", CUSTOM))
    const input = document.createElement("input")
    input.type = "text"
    input.name = `${provider}.${tier}.custom`
    input.placeholder = "model id"
    input.setAttribute("aria-label", `${LABEL[provider]} ${tier} custom model id`)
    input.spellcheck = false
    select.value = known ? current : CUSTOM
    input.value = known ? "" : current
    input.hidden = known
    select.addEventListener("change", () => {
      input.hidden = select.value !== CUSTOM
      if (!input.hidden) input.focus()
      refreshReasoning(provider, tier)
    })
    cell.append(select, input)
    return cell
  }

  /** Efforts offered follow the chosen model when the CLI says which it accepts. */
  function refreshReasoning(provider: ProviderId, tier: Tier) {
    const select = dialog.querySelector<HTMLSelectElement>(`select[name="${provider}.${tier}.reasoning"]`)
    if (!select) return
    const model = readModel(provider, tier)
    const levels = options?.[provider].models.find((m) => m.id === model)?.reasoning ?? options?.[provider].reasoningLevels ?? []
    const current = select.value
    select.replaceChildren(new Option(levels.length ? "CLI default effort" : "No effort setting", ""))
    for (const l of levels) select.add(new Option(l, l))
    if (current && !levels.includes(current)) select.add(new Option(`${current} (not listed for this model)`, current))
    select.value = current
    select.disabled = levels.length === 0 && !current
  }

  function readModel(provider: ProviderId, tier: Tier): string {
    const select = dialog.querySelector<HTMLSelectElement>(`select[name="${provider}.${tier}.model"]`)
    const input = dialog.querySelector<HTMLInputElement>(`input[name="${provider}.${tier}.custom"]`)
    return (select?.value === CUSTOM ? input?.value : select?.value)?.trim() ?? ""
  }

  function readValues(): SettingsValues {
    const values = {} as SettingsValues
    for (const p of PROVIDERS) {
      values[p] = {
        tiers: {} as Record<Tier, string>,
        reasoning: {} as Record<Tier, string>,
        trustWorkspace: dialog.querySelector<HTMLInputElement>(`input[name="${p}.trust"]`)?.checked ?? false,
      }
      for (const t of TIERS) {
        values[p].tiers[t] = readModel(p, t)
        values[p].reasoning[t] = dialog.querySelector<HTMLSelectElement>(`select[name="${p}.${t}.reasoning"]`)?.value ?? ""
      }
    }
    return values
  }

  function render(snapshot: SettingsSnapshot) {
    $("scope-project").textContent = snapshot.paths.project
    $("scope-user").textContent = snapshot.paths.user
    body.replaceChildren()
    for (const p of PROVIDERS) {
      const section = document.createElement("section")
      section.className = "provider"
      section.innerHTML = `<h3>${LABEL[p]}</h3>`
      for (const t of TIERS) {
        const row = document.createElement("div")
        row.className = "tier-row"
        const label = document.createElement("span")
        label.className = "tier"
        label.textContent = t
        const reasoning = document.createElement("select")
        reasoning.name = `${p}.${t}.reasoning`
        reasoning.setAttribute("aria-label", `${LABEL[p]} ${t} reasoning effort`)
        reasoning.add(new Option("", snapshot.values[p].reasoning[t]))
        reasoning.value = snapshot.values[p].reasoning[t]
        const test = document.createElement("button")
        test.type = "button"
        test.className = "ghost"
        test.textContent = "Test"
        const result = document.createElement("div")
        result.className = "test-result muted"
        test.addEventListener("click", () => runTest(p, t, result, test))
        row.append(label, modelSelect(p, t, snapshot.values[p].tiers[t]), reasoning, test, result)
        section.append(row)
      }
      if (options?.[p].supportsTrustOverride) {
        const trust = document.createElement("label")
        trust.className = "trust"
        trust.innerHTML = `<input type="checkbox" name="${p}.trust" /><span>Run in folders ${LABEL[p]} has not been told to trust<small>Without this, ${LABEL[p]} refuses to work in an untrusted folder and the router falls back to another backend. With it, ${LABEL[p]} also loads that folder's own ${LABEL[p]} settings and extensions without asking.</small></span>`
        ;(trust.querySelector("input") as HTMLInputElement).checked = snapshot.values[p].trustWorkspace
        section.append(trust)
      }
      body.append(section)
      for (const t of TIERS) refreshReasoning(p, t)
    }
    saveButton.disabled = false
  }

  function runTest(provider: ProviderId, tier: Tier, result: HTMLElement, button: HTMLButtonElement) {
    const model = readModel(provider, tier)
    if (!model) {
      result.className = "test-result fail"
      result.textContent = "Enter a model id first."
      return
    }
    const requestId = `test-${++testCounter}`
    pendingTests.set(requestId, result)
    button.disabled = true
    result.className = "test-result muted"
    result.innerHTML = `<span class="spinner"></span> Asking ${escapeHtml(model)}…`
    button.dataset.test = requestId
    send({
      type: "settings.test",
      requestId,
      workspace: workspace(),
      provider,
      model,
      reasoning: dialog.querySelector<HTMLSelectElement>(`select[name="${provider}.${tier}.reasoning"]`)?.value ?? "",
      trustWorkspace: dialog.querySelector<HTMLInputElement>(`input[name="${provider}.trust"]`)?.checked ?? false,
    })
  }

  function onMessage(msg: ServerMessage): boolean {
    switch (msg.type) {
      case "settings":
        options = msg.options
        render(msg.snapshot)
        return true
      case "settings.saved":
        if (msg.shadowed.length) {
          setStatus(`Saved to ${msg.path}, but this project's file overrides: ${msg.shadowed.join(", ")}.`, "warn")
        } else {
          setStatus(`Saved to ${msg.path}. Applies from the next request.`)
          setTimeout(() => dialog.open && dialog.close(), 900)
        }
        saveButton.disabled = false
        return true
      case "settings.error":
        setStatus(msg.message, "error")
        saveButton.disabled = false
        return true
      case "settings.tested": {
        const result = pendingTests.get(msg.requestId)
        pendingTests.delete(msg.requestId)
        dialog.querySelector<HTMLButtonElement>(`button[data-test="${msg.requestId}"]`)?.removeAttribute("disabled")
        if (!result) return true
        result.className = `test-result ${msg.ok ? "ok" : "fail"}`
        result.textContent = `${msg.ok ? "✓ Works" : "✗ Failed"} (${(msg.ms / 1000).toFixed(1)}s): ${msg.detail}`
        return true
      }
      default:
        return false
    }
  }

  $("open-settings").addEventListener("click", open)
  $("settings-close").addEventListener("click", () => dialog.close())
  $("settings-cancel").addEventListener("click", () => dialog.close())
  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault()
    const scope = (dialog.querySelector<HTMLInputElement>('input[name="scope"]:checked')?.value ?? "project") as SettingsScope
    saveButton.disabled = true
    setStatus("Saving…")
    send({ type: "settings.save", workspace: workspace(), scope, values: readValues() })
  })

  return { onMessage }
}
