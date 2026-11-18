// Firefox side panel loader — binds the sidebar to a tab, then starts the Chrome bundle.
//
// Chrome opens the side panel as sidepanel.html?tabId=<tab>, and the chat reads that
// parameter once at startup to decide which tab it controls. Without it, sending a
// message throws "No active tab" inside the bundle, which is never shown: the message
// silently disappears and the chat stays blank.
//
// Firefox loads the sidebar's default panel (plain sidepanel.html) whenever it is opened
// from the keyboard shortcut, the Sidebars menu, or on a tab that has no per-tab panel.
// So when the sidebar has no tabId, add the active tab of its window before the bundle
// reads the URL.
//
// sidepanel.html names the bundle in data-bundle on this script's tag, so the hashed
// file name only lives in the HTML that ships with each release.

const BUNDLE_SELECTOR = 'script[data-bundle]';

async function bindSidebarToActiveTab() {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  // Already bound, or a non-sidebar use of this page (detached window, MCP permission prompt).
  if (params.has('tabId') || params.has('mode') || params.has('mcpPermissionOnly')) return;
  try {
    // Pages opened in a tab or popup window have a current tab; the sidebar does not.
    if (await browser.tabs.getCurrent()) return;
    const win = await browser.windows.getCurrent();
    const [tab] = await browser.tabs.query({ active: true, windowId: win.id });
    if (!tab || tab.id == null || tab.id === browser.tabs.TAB_ID_NONE) return;
    params.set('tabId', String(tab.id));
    history.replaceState(history.state, '', url);
  } catch (e) {
    console.warn('[Claude Firefox] could not bind the sidebar to a tab', e);
  }
}

if (typeof browser !== 'undefined') await bindSidebarToActiveTab();

const bundle = document.querySelector(BUNDLE_SELECTOR)?.dataset.bundle;
if (bundle) {
  await import(bundle);
} else {
  console.error('[Claude Firefox] sidepanel.html has no data-bundle script');
}
