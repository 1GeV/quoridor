// Finish the one-time isolation reload before a game can start.
async function enableThreads() {
  if (!isSecureContext || !("serviceWorker" in navigator)) return;
  const retryKey = "quoridor.isolation.reload.v1";
  let timer, changed;
  try {
    const registration = navigator.serviceWorker.register(new URL("./isolation-sw.js", import.meta.url), { scope: "./", updateViaCache: "none" });
    void registration.catch(() => {});
    if (crossOriginIsolated) { void registration.catch(() => {}); return; }
    try { if (sessionStorage.getItem(retryKey)) return; } catch { return; }
    const controlled = new Promise((resolve) => {
      changed = () => { if (navigator.serviceWorker.controller) resolve(true); };
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      changed();
    });
    const ready = registration.then(() => controlled);
    const acquired = await Promise.race([ready, new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2000); })]);
    if (acquired) {
      sessionStorage.setItem(retryKey, "1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      location.reload();
      // A browser that blocks this reload must still get a playable page.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch { /* Storage-disabled browsers retain the single-threaded path. */ }
  finally {
    clearTimeout(timer);
    if (changed) navigator.serviceWorker.removeEventListener("controllerchange", changed);
  }
}
await enableThreads();
await import("./app.js?v=room-retry");
