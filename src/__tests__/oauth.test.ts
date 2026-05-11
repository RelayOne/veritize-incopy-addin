// VZ-199-5 — OAuth 2.1 sign-in tests for the InCopy add-in.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  refreshAccessToken,
  exchangeCodeForTokens,
  loadStoredOAuthTokens,
  persistTokens,
  clearStoredOAuthTokens,
  refreshOnUnauthorized,
  revokeAndSignOut,
  pkcePair,
  bytesToBase64Url,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPES,
  APP_BASE,
} from "../auth/signInWithOAuth";
import { setSecureStorage } from "../uxp/host";

const originalFetch = globalThis.fetch;

function makeMemStore(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => { raw.set(k, v); },
    removeItem: (k) => { raw.delete(k); },
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
  setSecureStorage(makeMemStore());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSecureStorage(null);
});

describe("buildAuthorizeUrl (VZ-199-5)", () => {
  it("targets the configured issuer /oauth/authorize", () => {
    const u = new URL(buildAuthorizeUrl("CHALLENGE", "STATE"));
    expect(u.origin).toBe(new URL(APP_BASE).origin);
    expect(u.pathname).toBe("/oauth/authorize");
  });

  it("uses client_id=veritize-incopy-addin (matches the seed)", () => {
    expect(CLIENT_ID).toBe("veritize-incopy-addin");
    expect(buildAuthorizeUrl("c", "s")).toContain("client_id=veritize-incopy-addin");
  });

  it("uses redirect_uri=https://incopy.veritize.app/oauth/callback", () => {
    expect(REDIRECT_URI).toBe("https://incopy.veritize.app/oauth/callback");
    const u = new URL(buildAuthorizeUrl("c", "s"));
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("requests S256 PKCE with the supplied challenge + state", () => {
    const u = new URL(buildAuthorizeUrl("CHAL", "ST"));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("state")).toBe("ST");
    expect(u.searchParams.get("response_type")).toBe("code");
  });

  it("requests scan:write claims:read scopes", () => {
    expect(SCOPES).toBe("scan:write claims:read");
    const u = new URL(buildAuthorizeUrl("c", "s"));
    expect(u.searchParams.get("scope")).toBe(SCOPES);
  });
});

describe("pkcePair (VZ-199-5)", () => {
  it("derives a base64url-sha256 challenge from the verifier", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43); // 32 bytes b64url
    // No padding, no +//=.
    expect(verifier).not.toMatch(/[+/=]/);
    expect(challenge).not.toMatch(/[+/=]/);
    // Challenge is a 32-byte SHA-256 digest base64url-encoded -> 43 chars.
    expect(challenge.length).toBe(43);
  });

  it("produces different verifiers on each call", async () => {
    const a = await pkcePair();
    const b = await pkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("bytesToBase64Url (VZ-199-5)", () => {
  it("strips padding and converts +,/ to -,_", () => {
    // 4-byte input encodes to 8 chars with potential padding/special chars.
    const bytes = new Uint8Array([0xff, 0xfb, 0xff, 0xff]);
    const out = bytesToBase64Url(bytes);
    expect(out).not.toMatch(/[+/=]/);
  });
});

describe("exchangeCodeForTokens (VZ-199-5)", () => {
  it("POSTs application/x-www-form-urlencoded with grant_type=authorization_code", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer",
      }),
    });
    const tokens = await exchangeCodeForTokens("authcode", "ver");
    expect(tokens.access_token).toBe("AT");
    expect(tokens.refresh_token).toBe("RT");
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`${APP_BASE}/oauth/token`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init.body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=authcode");
    expect(body).toContain("code_verifier=ver");
    expect(body).toContain("client_id=veritize-incopy-addin");
  });

  it("throws OAuthError on non-2xx", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({ error: "invalid_grant" }),
    });
    await expect(exchangeCodeForTokens("c", "v")).rejects.toThrow(/invalid_grant/);
  });
});

describe("refreshAccessToken (VZ-199-5)", () => {
  it("POSTs grant_type=refresh_token and persists the new pair", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new_AT", refresh_token: "new_RT", expires_in: 1800, token_type: "Bearer",
      }),
    });
    const tokens = await refreshAccessToken("old_RT");
    expect(tokens.access_token).toBe("new_AT");
    expect(tokens.refresh_token).toBe("new_RT");
    expect(tokens.expires_in).toBe(1800);
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
    // Persisted to the in-memory store via setSecureStorage.
    const stored = await loadStoredOAuthTokens();
    expect(stored?.access_token).toBe("new_AT");
  });

  it("throws OAuthError on non-2xx response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({ error: "invalid_grant" }),
    });
    await expect(refreshAccessToken("bad")).rejects.toThrow(/refresh returned 400/);
  });
});

describe("token storage round-trip (VZ-199-5)", () => {
  it("returns null when no tokens are stored", async () => {
    const stored = await loadStoredOAuthTokens();
    expect(stored).toBeNull();
  });

  it("persistTokens + loadStoredOAuthTokens round-trips", async () => {
    const t = { access_token: "A", refresh_token: "R", expires_in: 60, expires_at: Date.now() + 60000 };
    await persistTokens(t);
    const back = await loadStoredOAuthTokens();
    expect(back?.access_token).toBe("A");
    expect(back?.refresh_token).toBe("R");
    expect(back?.expires_at).toBe(t.expires_at);
  });

  it("clearStoredOAuthTokens removes all three keys", async () => {
    await persistTokens({ access_token: "A", refresh_token: "R", expires_in: 60, expires_at: Date.now() + 60000 });
    await clearStoredOAuthTokens();
    expect(await loadStoredOAuthTokens()).toBeNull();
  });
});

describe("refreshOnUnauthorized (VZ-199-5)", () => {
  it("returns null when no tokens are stored", async () => {
    const r = await refreshOnUnauthorized();
    expect(r).toBeNull();
  });

  it("rotates the access token using the stored refresh_token", async () => {
    await persistTokens({ access_token: "old", refresh_token: "old_R", expires_in: 0, expires_at: Date.now() - 1 });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "rotated", refresh_token: "new_R", expires_in: 3600, token_type: "Bearer" }),
    });
    const r = await refreshOnUnauthorized();
    expect(r).toBe("rotated");
  });

  it("clears tokens when refresh fails (forces user to re-sign-in)", async () => {
    await persistTokens({ access_token: "A", refresh_token: "R", expires_in: 60, expires_at: Date.now() + 60000 });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 400, json: async () => ({ error: "invalid_grant" }),
    });
    const r = await refreshOnUnauthorized();
    expect(r).toBeNull();
    expect(await loadStoredOAuthTokens()).toBeNull();
  });
});

describe("revokeAndSignOut (VZ-199-5)", () => {
  it("POSTs /oauth/revoke with the refresh token then clears local state", async () => {
    await persistTokens({ access_token: "A", refresh_token: "R", expires_in: 60, expires_at: Date.now() + 60000 });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, status: 200, text: async () => "",
    });
    await revokeAndSignOut();
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`${APP_BASE}/oauth/revoke`);
    const body = (call[1] as RequestInit).body as string;
    expect(body).toContain("token=R");
    expect(await loadStoredOAuthTokens()).toBeNull();
  });

  it("still clears local tokens even when /oauth/revoke fails", async () => {
    await persistTokens({ access_token: "A", refresh_token: "R", expires_in: 60, expires_at: Date.now() + 60000 });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));
    await revokeAndSignOut();
    expect(await loadStoredOAuthTokens()).toBeNull();
  });
});
