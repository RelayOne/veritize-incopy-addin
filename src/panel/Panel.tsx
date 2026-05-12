// src/panel/Panel.tsx — top-level panel UI.  MVP shape:
//   - Sign-in button (or signed-in state).
//   - Scan button (runs the chunked scan).
//   - List of claim cards with verdict + "Show in document" button.
//
// Logic is in src/auth, src/api, src/document — this component
// orchestrates them.

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { signInWithOAuth, loadStoredOAuthTokens, clearStoredOAuthTokens } from "../auth/signInWithOAuth";
import { readDocumentParagraphs } from "../document/readParagraphs";
import { applyVerdictHighlights, scrollToClaim } from "../document/highlight";
import { scanChunked } from "../api/scan";
import type { ScanClaim } from "../api/scan";

interface PanelState {
  signedIn: boolean;
  busy: boolean;
  error: string | null;
  claims: ScanClaim[];
}

export function Panel(): ReactElement {
  const [state, setState] = useState<PanelState>({
    signedIn: false,
    busy: false,
    error: null,
    claims: [],
  });

  useEffect(() => {
    void loadStoredOAuthTokens().then((t) => {
      setState((s) => ({ ...s, signedIn: t !== null }));
    });
  }, []);

  const onSignIn = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      await signInWithOAuth();
      setState((s) => ({ ...s, signedIn: true, busy: false }));
    } catch (e) {
      setState((s) => ({
        ...s,
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  const onSignOut = useCallback(async () => {
    await clearStoredOAuthTokens();
    setState((s) => ({ ...s, signedIn: false, claims: [] }));
  }, []);

  const onScan = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const tokens = await loadStoredOAuthTokens();
      if (!tokens) throw new Error("Not signed in.");
      const paragraphs = readDocumentParagraphs();
      const claims = await scanChunked(tokens.access_token, paragraphs);
      await applyVerdictHighlights(claims);
      setState((s) => ({ ...s, busy: false, claims }));
    } catch (e) {
      setState((s) => ({
        ...s,
        busy: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  return (
    <div style={{ padding: 12, fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ margin: "0 0 12px" }}>Veritize</h2>
      {state.error && (
        <div style={{ color: "#dc2626", marginBottom: 8 }}>{state.error}</div>
      )}
      {!state.signedIn ? (
        <button onClick={() => void onSignIn()} disabled={state.busy}>
          {state.busy ? "Signing in…" : "Sign in"}
        </button>
      ) : (
        <>
          <button onClick={() => void onScan()} disabled={state.busy}>
            {state.busy ? "Scanning…" : "Scan document"}
          </button>{" "}
          <button onClick={() => void onSignOut()} disabled={state.busy}>
            Sign out
          </button>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 12 }}>
            {state.claims.map((c) => (
              <li
                key={c.id}
                style={{
                  border: "1px solid #ddd",
                  padding: 8,
                  marginBottom: 8,
                  borderRadius: 4,
                }}
              >
                <div style={{ fontWeight: 600 }}>{c.verdict.toUpperCase()}</div>
                <div style={{ margin: "4px 0" }}>{c.claim_text}</div>
                <button onClick={() => void scrollToClaim(c)}>Show in document</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
