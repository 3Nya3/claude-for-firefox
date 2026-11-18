// Firefox action handler — intercepts action.onClicked to toggle the
// Firefox sidebar instead of opening a Chrome sidePanel.

(function () {
  'use strict';

  // Stub chrome.sidePanel so calls from the Chrome bundle don't throw
  if (typeof chrome !== 'undefined' && !chrome.sidePanel) {
    chrome.sidePanel = {
      open: function () { return Promise.resolve(); },
      close: function () { return Promise.resolve(); },
      setOptions: function () { return Promise.resolve(); },
      setPanelBehavior: function () { return Promise.resolve(); },
      getOptions: function () { return Promise.resolve({}); },
      getPanelBehavior: function () { return Promise.resolve({}); },
    };
  }

  if (typeof chrome === 'undefined' || !chrome.action || !chrome.action.onClicked) {
    return;
  }

  var sidebarApi = chrome.sidebarAction || (typeof browser !== 'undefined' && browser.sidebarAction);
  if (!sidebarApi) {
    console.warn('[firefox-action-handler] sidebarAction API not available');
    return;
  }

  // The bundle's own onClicked listener sets this tab's panel to sidepanel.html?tabId=<tab>
  // (chrome.sidePanel.setOptions -> sidebarAction.setPanel with tabId). Don't set a global
  // panel here: it would bind every other tab's sidebar to the clicked tab. Tabs without a
  // per-tab panel load the default sidepanel.html, which binds itself to the active tab
  // (firefox-sidepanel-loader.js).
  chrome.action.onClicked.addListener(function () {
    // Toggle sidebar visibility
    if (sidebarApi.toggle) {
      sidebarApi.toggle();
    } else if (sidebarApi.open) {
      sidebarApi.open();
    }
  });
})();
