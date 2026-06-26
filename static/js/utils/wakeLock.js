// static/js/utils/wakeLock.js
// Keep the screen awake while the dashboard is open (mobile especially) so it
// behaves like a media app the user is actively watching. Uses the Screen Wake
// Lock API; the OS auto-releases the lock when the tab is hidden, so we
// re-acquire whenever the page becomes visible again.
let lock = null;

async function acquire() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch {
    // Denied or not allowed in this context — retry on the next gesture/visibility.
  }
}

export function initWakeLock() {
  acquire();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();
  });
  // Some browsers only grant the lock from a user gesture; retry on first input.
  ['pointerdown', 'keydown'].forEach(ev =>
    window.addEventListener(ev, acquire, { passive: true }));
}
