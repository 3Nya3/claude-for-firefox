// Firefox background script entry point — ES module loader
// Imports shims and patches before the main service worker bundle.
// Static imports evaluate in order, so every shim is in place before the bundle runs.

import './firefox-compat.js';
import './firefox-sw-scope.js';
import './firefox-offscreen-shim.js';
import './firefox-oauth-interceptor.js';
import './firefox-token-injector.js';
import './firefox-action-handler.js';
// Chrome's own loader always has this name; it imports the hashed bundle for the current release.
import './service-worker-loader.js';
