// Audio output device picker: an "Output device" submenu in Webamp's main
// (Winamp logo) menu. Playback moves with HTMLMediaElement.setSinkId.
//
// Chromium (WebView2) shows device names and ids only to a page holding
// microphone permission; src-tauri/src/audio_out.rs grants it at startup and
// nothing here ever records. WKWebView has no setSinkId, so on macOS the
// submenu is never added. The choice is kept by device name in localStorage
// and re-applied at launch and whenever devices come and go.

export interface Output { id: string; label: string }
type DeviceLike = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>;

const KEY = 'wamptube.outputDevice'; // chosen device's label; absent = system default

/** Real output devices, without Chromium's "default" and "communications" aliases. */
export function realOutputs(devices: DeviceLike[]): Output[] {
  return devices
    .filter((d) => d.kind === 'audiooutput' && d.label && d.deviceId &&
      d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ id: d.deviceId, label: d.label }));
}

/** Name of the system default device, from Chromium's "Default - <name>" alias. */
export function defaultOutputName(devices: DeviceLike[]): string {
  const d = devices.find((x) => x.kind === 'audiooutput' && x.deviceId === 'default');
  return d?.label.replace(/^Default - /, '') ?? '';
}

function savedLabel(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}
function saveLabel(label: string) {
  try { if (label) localStorage.setItem(KEY, label); else localStorage.removeItem(KEY); } catch { /* not kept */ }
}

export function installOutputMenu(el: HTMLMediaElement) {
  if (!('setSinkId' in el) || !navigator.mediaDevices?.enumerateDevices) return;
  let outputs: Output[] = [];
  let defaultName = '';

  const apply = async () => {
    const want = savedLabel();
    const id = outputs.find((o) => o.label === want)?.id ?? ''; // gone or unset: system default
    if (el.sinkId === id) return;
    try {
      await el.setSinkId(id);
      console.warn(`[audio] output: ${want && id ? want : `system default (${defaultName})`}`);
    } catch (e) {
      console.error('[audio] setSinkId failed', String(e));
    }
  };
  const refresh = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputs = realOutputs(devices);
    defaultName = defaultOutputName(devices);
    await apply();
  };
  void refresh();
  navigator.mediaDevices.addEventListener('devicechange', () => void refresh());

  // Webamp renders a context menu into #webamp-context-menu only while it is open.
  // Add the submenu to the main menu (the one ending in "Exit"), above "Options".
  const addTo = (menu: Element) => {
    if (outputs.length === 0 || menu.querySelector(':scope > .wamptube-output')) return;
    const items = [...menu.children];
    const exit = items.find((li) => li.textContent === 'Exit');
    if (!exit) return;
    const current = savedLabel();
    const sub = document.createElement('ul');
    const item = (label: string, text: string) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (label === current || (!current && label === '')) li.classList.add('checked');
      li.addEventListener('click', () => { saveLabel(label); void apply(); }); // Webamp closes the menu
      return li;
    };
    sub.append(
      item('', defaultName ? `System default (${defaultName})` : 'System default'),
      ...outputs.map((o) => item(o.label, o.label)),
    );
    const parent = document.createElement('li');
    parent.className = 'parent wamptube-output';
    parent.append(sub, 'Output device');
    const options = items.find((li) => li.classList.contains('parent') && li.lastChild?.textContent === 'Options');
    menu.insertBefore(parent, options ?? exit);
  };
  new MutationObserver(() => {
    const host = document.getElementById('webamp-context-menu');
    host?.querySelectorAll('ul.context-menu').forEach(addTo);
  }).observe(document.body, { childList: true, subtree: true });
}
