// Google sign-in for a static web app: the OAuth 2 implicit ("token") flow, without any Google
// script. The consent page opens in a popup and redirects to our own `oauth.html`, which hands
// the URL fragment (access token, expiry, state) back over a BroadcastChannel and closes.
// A BroadcastChannel is used instead of `window.opener` because Google's pages cut the opener
// link (Cross-Origin-Opener-Policy), which also makes `popup.closed` unreliable.
//
// The pure parts (URL building, fragment parsing) are testable in Node; `popupAuthorize`
// needs a browser.

import { GDRIVE_SCOPE } from './gdrive.ts';
import { randomToken } from './util.ts';

export const OAUTH_CHANNEL = 'vibesketch-oauth';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface AccessToken { accessToken: string; expiresAt: number }

/** What has to be registered as "Authorised redirect URI" in the Google Cloud console. */
export function oauthRedirectUri(): string {
  const doc = (globalThis as { document?: { baseURI?: string } }).document;
  if (!doc?.baseURI) return '';
  try { return new URL('oauth.html', doc.baseURI).href; } catch { return ''; }
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; silent?: boolean }): string {
  const q = new URLSearchParams({
    response_type: 'token',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: GDRIVE_SCOPE,
    state: p.state,
    include_granted_scopes: 'true',
  });
  if (p.silent) q.set('prompt', 'none');
  return `${AUTH_URL}?${q}`;
}

/**
 * Parse the fragment Google appended to the redirect URI. Returns null when it belongs to a
 * different sign-in attempt (wrong `state`), throws when Google reported an error.
 */
export function parseAuthFragment(hash: string, expectedState: string, now = Date.now()): AccessToken | null {
  const q = new URLSearchParams(hash.replace(/^[#?]/, ''));
  if (!expectedState || q.get('state') !== expectedState) return null;
  const error = q.get('error');
  if (error) {
    const friendly: Record<string, string> = {
      access_denied: 'Access to Google Drive was not granted',
      interaction_required: 'Google needs you to sign in again',
      login_required: 'Google needs you to sign in again',
      consent_required: 'Google needs your consent again',
    };
    throw new Error(friendly[error] ?? `Google sign-in failed: ${error}`);
  }
  const accessToken = q.get('access_token');
  if (!accessToken) throw new Error('Google sign-in failed: no access token was returned');
  if ((q.get('token_type') ?? 'bearer').toLowerCase() !== 'bearer') throw new Error('Google sign-in failed: unexpected token type');
  const expiresIn = Number(q.get('expires_in'));
  return { accessToken, expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000 };
}

let cancelPrevious: (() => void) | null = null;

/**
 * Obtain an access token.
 *  - interactive: opens the consent popup. Must be called directly from a click handler: the
 *    popup is opened synchronously, before anything is awaited.
 *  - not interactive: one silent attempt (`prompt=none`) in a hidden iframe. This only works
 *    while the user is signed in to Google and the browser lets Google see its cookies inside
 *    a frame; otherwise it rejects and the user has to click "Connect" again.
 */
export function popupAuthorize(clientId: string, interactive: boolean): Promise<AccessToken> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return Promise.reject(new Error('Google sign-in needs a browser window'));
  }
  const state = randomToken(24);
  const url = buildAuthUrl({ clientId, redirectUri: oauthRedirectUri(), state, silent: !interactive });

  let popup: Window | null = null;
  let frame: HTMLIFrameElement | null = null;
  if (interactive) {
    cancelPrevious?.();
    const w = 520, h = 640;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    popup = window.open(url, 'vibesketch-oauth', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) return Promise.reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.'));
  } else {
    frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.src = url;
    document.body.appendChild(frame);
  }

  return new Promise<AccessToken>((resolve, reject) => {
    const channel = new BroadcastChannel(OAUTH_CHANNEL);
    const finish = (fn: () => void): void => {
      clearTimeout(timeout);
      channel.close();
      frame?.remove();
      if (interactive && cancelPrevious === cancel) cancelPrevious = null;
      fn();
    };
    const cancel = (): void => finish(() => reject(new Error('Sign-in was cancelled')));
    if (interactive) cancelPrevious = cancel;
    const timeout = setTimeout(
      () => finish(() => reject(new Error(interactive ? 'Sign-in timed out' : 'Google needs you to sign in again'))),
      interactive ? 5 * 60_000 : 15_000,
    );
    channel.onmessage = (ev: MessageEvent) => {
      const hash = (ev.data as { hash?: unknown } | null)?.hash;
      if (typeof hash !== 'string') return;
      try {
        const token = parseAuthFragment(hash, state);
        if (!token) return; // another tab's sign-in, or a forged message without our state
        finish(() => resolve(token));
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
      try { popup?.close(); } catch { /* opener link may be severed */ }
    };
  });
}
