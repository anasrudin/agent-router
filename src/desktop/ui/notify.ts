import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"

let permission: Promise<boolean> | undefined

/** Asks once per app run, on the first notification that would be shown. */
function permitted(): Promise<boolean> {
  permission ??= (async () => (await isPermissionGranted()) || (await requestPermission()) === "granted")().catch(() => false)
  return permission
}

/** An OS notification, only while the window is in the background: in front, the chat already shows it. */
export function notifyIfAway(title: string, body: string): void {
  if (document.hasFocus()) return
  void permitted().then((ok) => {
    if (ok) sendNotification({ title, body })
  })
}
