import { speechText } from "./markdown"

/** Read aloud with the device's own voice, where the webview has one (not every Linux build does). */
export const canSpeak = (): boolean => typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined"

let speaking: HTMLElement | undefined

/** Speak `markdown`; pressing the same button again stops. Returns whether it started. */
export function toggleSpeech(markdown: string, button: HTMLElement): boolean {
  if (!canSpeak()) return false
  const wasThis = speaking === button
  speechSynthesis.cancel()
  speaking?.setAttribute("aria-pressed", "false")
  speaking = undefined
  if (wasThis) return false
  const utterance = new SpeechSynthesisUtterance(speechText(markdown))
  utterance.onend = utterance.onerror = () => {
    if (speaking === button) {
      button.setAttribute("aria-pressed", "false")
      speaking = undefined
    }
  }
  speaking = button
  button.setAttribute("aria-pressed", "true")
  speechSynthesis.speak(utterance)
  return true
}

let audio: AudioContext | undefined

/** A short chime (Ghostex's sound notifications): two rising notes when done, a repeated note when it needs you. */
export function chime(kind: "done" | "attention"): void {
  try {
    audio ??= new AudioContext()
    const ctx = audio
    const notes = kind === "done" ? [660, 880] : [740, 740]
    notes.forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.14
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.25)
    })
  } catch {
    // No audio device: the notification is enough.
  }
}
