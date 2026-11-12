/**
 * Firefox Token Lifecycle Manager
 *
 * Anthropic's OAuth server only accepts chrome-extension:// redirect URIs, so the
 * extension cannot log in by itself in Firefox. Instead it borrows Claude Code's
 * session: the native host reads Claude Code's credentials on request
 * (`get_tokens`) and hands back the current access token. Each time Claude Code
 * refreshes its token, the extension picks up the new one on its next sync.
 *
 * The refresh token is never stored. With a refresh token present, the extension's
 * own OAuth code rotates it, which invalidates Claude Code's copy and logs it out.
 * Without one, the extension simply uses the access token until it expires and
 * this manager swaps in Claude Code's newer token.
 *
 * Token storage keys in chrome.storage.local:
 *   accessToken, tokenExpiry   (refreshToken is actively removed)
 *
 * Fallback source (written by the installer / refresh-tokens script):
 *   firefox-injected-tokens.json
 */
(function () {
  'use strict';

  // Guard: only activate in Firefox
  if (typeof browser === 'undefined') return;

  const LOG_PREFIX = '[Claude Firefox Token]';
  const NATIVE_HOST = 'com.anthropic.claude_browser_extension';
  const TOKEN_FILE = chrome.runtime.getURL('firefox-injected-tokens.json');
  const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  const INITIAL_DELAY_MS = 500;

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const error = (...args) => console.error(LOG_PREFIX, ...args);

  function normalize(data) {
    if (!data || !data.accessToken) return null;
    const expiry = typeof data.expiresAt === 'number' ? data.expiresAt
      : (typeof data.tokenExpiry === 'number' ? data.tokenExpiry : 0);
    return { accessToken: data.accessToken, tokenExpiry: expiry };
  }

  /** Ask the native host for Claude Code's current tokens. */
  async function readHostTokens() {
    try {
      const resp = await browser.runtime.sendNativeMessage(NATIVE_HOST, { type: 'get_tokens' });
      if (resp && resp.error) warn('Native host:', resp.error);
      return normalize(resp);
    } catch (e) {
      warn('Native host token lookup failed:', e.message);
      return null;
    }
  }

  /** Read tokens from the bundled JSON file written by the installer. */
  async function readTokenFile() {
    try {
      const resp = await fetch(TOKEN_FILE);
      if (!resp.ok) return null;
      return normalize(await resp.json());
    } catch (_) {
      return null;
    }
  }

  const isUsable = (t) => Boolean(t && t.accessToken && (!t.tokenExpiry || Date.now() < t.tokenExpiry));

  /**
   * Pull the newest available token into storage. Returns true if storage holds a
   * usable (unexpired) access token afterwards.
   */
  let inflight = null;
  function syncTokens() {
    if (inflight) return inflight;
    inflight = (async () => {
      const stored = await browser.storage.local.get(['accessToken', 'refreshToken', 'tokenExpiry']);
      if (stored.refreshToken) {
        await browser.storage.local.remove('refreshToken');
        log('Removed stored refresh token (it would log Claude Code out when rotated)');
      }

      const candidates = [await readHostTokens(), await readTokenFile()].filter(Boolean);
      const best = candidates.sort((a, b) => (b.tokenExpiry || 0) - (a.tokenExpiry || 0))[0];
      const current = normalize(stored);

      if (best && best.accessToken !== stored.accessToken &&
          (!isUsable(current) || (best.tokenExpiry || 0) > (current.tokenExpiry || 0))) {
        await browser.storage.local.set({ accessToken: best.accessToken, tokenExpiry: best.tokenExpiry });
        log('Stored newer access token from Claude Code, expires', new Date(best.tokenExpiry).toISOString());
        return isUsable(best);
      }
      if (!isUsable(current)) warn('No unexpired token available. Use Claude Code once so it refreshes its login.');
      return isUsable(current);
    })().finally(() => { inflight = null; });
    return inflight;
  }

  // Used by firefox-compat.js when the login button is pressed.
  globalThis.__claudeFirefoxSyncTokens = syncTokens;

  // --- Patch chrome.identity.launchWebAuthFlow ---

  if (chrome.identity && typeof chrome.identity.launchWebAuthFlow === 'function') {
    const _originalLaunchWebAuthFlow = chrome.identity.launchWebAuthFlow.bind(chrome.identity);

    chrome.identity.launchWebAuthFlow = function (details, callback) {
      const isPromise = typeof callback !== 'function';

      const handleResult = async (err) => {
        warn('launchWebAuthFlow failed, falling back to Claude Code tokens:', err && err.message);
        const ok = await syncTokens().catch(() => false);
        if (!ok && details && details.interactive) {
          const msg = 'Firefox login is not supported by Anthropic. Log in with Claude Code (`claude`); the extension uses its session.';
          if (!isPromise) {
            chrome.runtime.lastError = { message: msg };
            callback(undefined);
            return undefined;
          }
          throw new Error(msg);
        }
        // Callers expect a redirect URL we cannot synthesize; undefined makes them re-check storage.
        if (!isPromise) callback(undefined);
        return undefined;
      };

      try {
        if (isPromise) {
          return _originalLaunchWebAuthFlow(details).catch((err) => handleResult(err));
        }
        _originalLaunchWebAuthFlow(details, (redirectUrl) => {
          if (chrome.runtime.lastError || !redirectUrl) {
            handleResult(chrome.runtime.lastError || new Error('No redirect URL'));
          } else {
            callback(redirectUrl);
          }
        });
      } catch (e) {
        return handleResult(e);
      }
    };

    log('Patched chrome.identity.launchWebAuthFlow');
  }

  // --- Sync triggers ---

  setTimeout(() => {
    syncTokens().catch((e) => error('Initial token sync failed:', e.message));
  }, INITIAL_DELAY_MS);

  setInterval(() => {
    syncTokens().catch((e) => error('Periodic token sync failed:', e.message));
  }, SYNC_INTERVAL_MS);

  // The extension deletes the access token after a 401, or writes a refresh token after its
  // own OAuth flow; react immediately in both cases.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const lostAccess = changes.accessToken && !changes.accessToken.newValue;
    const gotRefresh = changes.refreshToken && changes.refreshToken.newValue;
    if (lostAccess || gotRefresh) {
      syncTokens().catch((e) => error('Token sync after storage change failed:', e.message));
    }
  });

  log('Token lifecycle manager initialized');
})();
