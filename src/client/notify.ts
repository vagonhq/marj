let audio: AudioContext | null = null;

/**
 * A short two-note chime, synthesised so there is no asset to ship. Browsers
 * only allow audio after a user gesture, so the context is created lazily and
 * resumed on every play.
 */
export function chime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audio ??= new Ctor();
    void audio.resume();
    const now = audio.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const start = now + index * 0.11;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    }
  } catch {
    // no audio device, autoplay policy, whatever — never break the page over it
  }
}

export async function askForNotifications(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

/**
 * A desktop notification when the tab is in the background — which is the usual
 * case, since the reviewer is watching the terminal — and nothing otherwise:
 * the caller shows an in-page toast either way.
 */
export function desktopNotify(title: string, body: string, tag: string, onClick: () => void): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const notification = new Notification(title, { body, tag, renotify: true } as NotificationOptions);
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Safari throws for the constructor outside a service worker
  }
}
