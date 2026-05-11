// src/auth/signInWithOAuth.ts — VZ-197 OAuth 2.1 sign-in for the
// InCopy UXP plugin.
//
// Flow (VZ-199-5):
//   1. Generate a 32-byte code_verifier + base64url-sha256 challenge.
//   2. Render an in-panel iframe whose src is /oauth/authorize with
//      response_type=code, PKCE challenge, and state.
//   3. /oauth/callback (served by Cloudflare Pages at
//      incopy.veritize.app/oauth/callback) postMessages {code,state}
//      back to the plugin window.
//   4. The plugin's window 'message' listener validates state then
//      POSTs to /oauth/token to exchange the code for tokens.
//   5. Tokens persist in UXP's localStorage (scoped per plugin id).
//
// The PKCE code_verifier never leaves the plugin process; the iframe
// callback page only ever sees the code + state, both single-use.

import { getSecureStorage } from "../uxp/host";

// ---------------------------------------------------------------------------
// Issuer config
// ---------------------------------------------------------------------------

// VITE_OAUTH_ISSUER overrides the default for dev/staging.  Default:
// staging issuer per spec MUST (sign-in works against staging).
export const APP_BASE: string =
  (typeof import.meta !== "undefined"
    ? (import.meta as ImportMeta & { env?: Record<string, string> }).env
        ?.VITE_OAUTH_ISSUER
    : undefined) ?? "https://app.veritize.app";

export const CLIENT_ID = "veritize-incopy-addin";
export const REDIRECT_URI = "https://incopy.veritize.app/oauth/callback";
export const SCOPES = "scan:write claims:read";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** Wall-clock millis when the access token expires. */
  expires_at: number;
}

export class OAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = bytesToBase64Url(randomBytes(32));
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

const ACCESS_KEY = "veritize.access_token";
const REFRESH_KEY = "veritize.refresh_token";
const EXPIRES_KEY = "veritize.expires_at";

export async function loadStoredOAuthTokens(): Promise<OAuthTokens | null> {
  try {
    const store = getSecureStorage();
    const access = store.getItem(ACCESS_KEY);
    const refresh = store.getItem(REFRESH_KEY);
    const expiresRaw = store.getItem(EXPIRES_KEY);
    if (!access || !refresh || !expiresRaw) return null;
    const expires_at = Number.parseInt(expiresRaw, 10);
    if (!Number.isFinite(expires_at)) return null;
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: Math.max(0, Math.floor((expires_at - Date.now()) / 1000)),
      expires_at,
    };
  } catch {
    return null;
  }
}

export async function persistTokens(t: OAuthTokens): Promise<void> {
  const store = getSecureStorage();
  store.setItem(ACCESS_KEY, t.access_token);
  store.setItem(REFRESH_KEY, t.refresh_token);
  store.setItem(EXPIRES_KEY, String(t.expires_at));
}

export async function clearStoredOAuthTokens(): Promise<void> {
  const store = getSecureStorage();
  store.removeItem(ACCESS_KEY);
  store.removeItem(REFRESH_KEY);
  store.removeItem(EXPIRES_KEY);
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(`${APP_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    let msg = `token exchange returned ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j && typeof j === "object" && j.error) msg = String(j.error);
    } catch {
      /* keep default msg */
    }
    throw new OAuthError("token_exchange_failed", msg);
  }
  const data = (await res.json()) as TokenResponse;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshAccessToken(refresh_token: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: CLIENT_ID,
  });
  const res = await fetch(`${APP_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new OAuthError("refresh_failed", `refresh returned ${res.status}`);
  }
  const data = (await res.json()) as TokenResponse;
  const next: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await persistTokens(next);
  return next;
}

// ---------------------------------------------------------------------------
// Authorize URL + iframe-driven sign-in
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: SCOPES,
    state,
  });
  return `${APP_BASE}/oauth/authorize?${p.toString()}`;
}

interface CallbackMessage {
  code?: string;
  state?: string;
  error?: string;
}

/**
 * Open an in-panel iframe at /oauth/authorize and wait for the
 * callback page to postMessage {code,state} back.  Used by the panel
 * UI's "Sign in" button.
 *
 * Implementation note: UXP panels are WebViews that support iframes
 * via the `webview` permission.  When the callback page (served at
 * incopy.veritize.app/oauth/callback) loads, it calls
 * window.parent.postMessage(...) which dispatches a 'message' event
 * on the plugin window.
 */
export function signInWithOAuth(): Promise<OAuthTokens> {
  return new Promise<OAuthTokens>((resolve, reject) => {
    void (async () => {
      const { verifier, challenge } = await pkcePair();
      const state = bytesToBase64Url(randomBytes(16));
      const url = buildAuthorizeUrl(challenge, state);

      const iframe = document.createElement("iframe");
      iframe.src = url;
      iframe.style.position = "fixed";
      iframe.style.inset = "0";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.style.background = "#fff";
      iframe.style.zIndex = "9999";
      iframe.title = "Veritize sign-in";

      const cleanup = (): void => {
        window.removeEventListener("message", onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      };

      const onMessage = (ev: MessageEvent): void => {
        // Browsers/UXP fire 'message' events from many sources (devtools,
        // dialogs).  Filter to messages whose data looks like a callback
        // payload (object with code/state or error fields).
        const data = ev.data as CallbackMessage | string | null;
        if (!data || typeof data !== "object") return;
        if (!("code" in data) && !("error" in data)) return;
        const payload = data as CallbackMessage;
        if (payload.error) {
          cleanup();
          reject(new OAuthError(payload.error, payload.error));
          return;
        }
        if (!payload.code) {
          cleanup();
          reject(new OAuthError("missing_code", "no code returned"));
          return;
        }
        if (payload.state !== state) {
          cleanup();
          reject(new OAuthError("state_mismatch", "OAuth state did not match"));
          return;
        }
        void exchangeCodeForTokens(payload.code, verifier)
          .then(async (tokens) => {
            await persistTokens(tokens);
            cleanup();
            resolve(tokens);
          })
          .catch((e: unknown) => {
            cleanup();
            if (e instanceof OAuthError) reject(e);
            else
              reject(
                new OAuthError(
                  "exchange_error",
                  e instanceof Error ? e.message : String(e),
                ),
              );
          });
      };

      window.addEventListener("message", onMessage);
      document.body.appendChild(iframe);
    })().catch((e: unknown) => {
      reject(
        e instanceof OAuthError
          ? e
          : new OAuthError("init_error", e instanceof Error ? e.message : String(e)),
      );
    });
  });
}

/**
 * Helper for /v1/* fetch wrappers: when a 401 comes back, call this
 * to rotate the access token and retry once.  Returns the new
 * access_token (caller re-issues the fetch with it) or null if
 * rotation failed (caller should drop to sign-in flow).
 */
export async function refreshOnUnauthorized(): Promise<string | null> {
  const stored = await loadStoredOAuthTokens();
  if (!stored) return null;
  try {
    const next = await refreshAccessToken(stored.refresh_token);
    return next.access_token;
  } catch {
    await clearStoredOAuthTokens();
    return null;
  }
}

/**
 * Revoke the stored refresh token via /oauth/revoke (RFC 7009).  Even
 * if revocation fails (e.g. network), we still clear local tokens so
 * the user is logged out client-side.
 */
export async function revokeAndSignOut(): Promise<void> {
  const stored = await loadStoredOAuthTokens();
  if (stored) {
    try {
      await fetch(`${APP_BASE}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: stored.refresh_token,
          client_id: CLIENT_ID,
        }).toString(),
      });
    } catch {
      /* swallow: clearing local tokens is the user-visible effect */
    }
  }
  await clearStoredOAuthTokens();
}
