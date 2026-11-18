// The agent's "Claude (MCP)" tab group on Firefox.
//
// Agents connected through MCP may only use tabs inside that native tab group. Two things
// Chrome handles and Firefox needs help with:
//
// 1. Reconnecting to the group. The bundle remembers the group id in storage.session,
//    which Firefox empties on every extension reload and browser restart, while the tab
//    group itself survives (session restore keeps it, possibly under a new id). The bundle
//    then forgets its group and opens yet another window on the next tool call. At
//    startup, if no id is stored, point it back at the existing group by title.
//
// 2. Adding tabs. In Chrome you drag a tab into the group in the tab strip. In Firefox that
//    only works in the native tab strip; tab managers such as Sidebery (or a hidden tab bar)
//    don't show native tab groups, so a tab dropped next to the agent's tab never joins.
//    "Let Claude use this tab" in the tab and page context menus works with any tab UI.

(function () {
  'use strict';

  if (typeof browser === 'undefined' || !browser.tabGroups || typeof browser.tabs.group !== 'function') {
    return;
  }

  const TAG = '[Claude Firefox]';
  const MENU_ID = 'claude-firefox-add-tab-to-mcp-group';
  // Storage key and title used by the bundle's tab group manager (MCP_TAB_GROUP_ID, "Claude (MCP)").
  const MCP_GROUP_KEY = 'mcpTabGroupId';
  const MCP_GROUP_TITLE = 'Claude (MCP)';
  // The bundle prefixes the group title with a status emoji while the agent works.
  const withoutStatusPrefix = (title) => (title || '').replace(/^(?:⌛|🔔|✅)\s*/u, '');

  async function storedGroupId() {
    try {
      const stored = (await browser.storage.session.get(MCP_GROUP_KEY))[MCP_GROUP_KEY];
      if (typeof stored === 'number') {
        await browser.tabGroups.get(stored);
        return stored;
      }
    } catch (_) { /* missing or stale */ }
    return null;
  }

  async function groupIdByTitle() {
    const groups = await browser.tabGroups.query({});
    const match = groups.find((g) => withoutStatusPrefix(g.title) === MCP_GROUP_TITLE);
    return match ? match.id : null;
  }

  async function findMcpGroupId() {
    return (await storedGroupId()) ?? (await groupIdByTitle());
  }

  // ─── 1. Reconnect after reload / restart ──────────────────────────
  (async () => {
    if ((await storedGroupId()) !== null) return;
    const id = await groupIdByTitle();
    if (id === null) return;
    // Re-check: the bundle may have stored a group of its own meanwhile.
    if ((await storedGroupId()) !== null) return;
    await browser.storage.session.set({ [MCP_GROUP_KEY]: id });
    console.log(TAG, 'reconnected to the existing Claude (MCP) tab group', id);
  })().catch((e) => console.warn(TAG, 'could not reconnect to the Claude (MCP) tab group', e));

  // ─── 2. "Let Claude use this tab" ─────────────────────────────────
  if (!browser.menus) return;

  function notify(message) {
    browser.notifications.create({ type: 'basic', iconUrl: '/icon-128.png', title: 'Claude', message }).catch(() => {});
  }

  async function addTabToMcpGroup(tab) {
    if (!tab || tab.id == null || tab.id === browser.tabs.TAB_ID_NONE) return;
    const groupId = await findMcpGroupId();
    if (groupId === null) {
      notify("Claude doesn't have a tab group yet. Ask Claude to use the browser first, then add tabs to it.");
      return;
    }
    if (tab.groupId === groupId) return;
    try {
      if (tab.pinned) await browser.tabs.update(tab.id, { pinned: false });
      // Moves the tab into the group's window if it is in another one.
      await browser.tabs.group({ tabIds: [tab.id], groupId });
    } catch (e) {
      console.warn(TAG, 'could not add tab to Claude\'s group', e);
      notify(`Couldn't add this tab to Claude's group: ${e.message}`);
    }
  }

  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: MENU_ID, title: 'Let Claude use this tab', contexts: ['tab', 'page'] });
  }).catch((e) => console.warn(TAG, 'tab menu setup failed', e));

  browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) addTabToMcpGroup(tab);
  });
})();
