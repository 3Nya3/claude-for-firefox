// Mark Firefox's background page as "the service worker" for the Chrome bundle.
//
// The bundle decides whether it is running as the background context with
// `"ServiceWorkerGlobalScope" in globalThis` (token refresh, alarms, navigation
// listeners, tab-group bookkeeping, ...). Firefox runs MV3 backgrounds as event
// pages, so that check is false and the background would behave like a UI page.
// Defining the name here, and only here, makes every such check correct without
// editing the minified bundle. Side panel / options pages never load this file,
// so they still take their non-background code paths.
//
// It is a bare function, so `self instanceof ServiceWorkerGlobalScope` stays false
// for libraries that need a real service worker.
if (!('ServiceWorkerGlobalScope' in globalThis)) {
  Object.defineProperty(globalThis, 'ServiceWorkerGlobalScope', {
    value: function ServiceWorkerGlobalScope() {},
    configurable: true,
    writable: true,
  });
}
