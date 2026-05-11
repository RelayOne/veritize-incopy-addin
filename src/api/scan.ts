// src/api/scan.ts — POST chunks to /v1/scan and map per-claim
// responses back to source paragraph indices.
//
// One HTTP call per chunk per the spec.  The claim response carries
// `paragraph_index` relative to the chunk's content; we rewrite it to
// the absolute document paragraph index using the chunk's index list.

import { chunkParagraphs } from "../document/readParagraphs";
import type { DocumentParagraph } from "../document/readParagraphs";
import { refreshOnUnauthorized } from "../auth/signInWithOAuth";

export type Verdict =
  | "verified"
  | "unverified"
  | "disputed"
  | "insufficient_evidence";

export interface ScanClaim {
  id: string;
  claim_text: string;
  verdict: Verdict;
  confidence: number;
  /** Absolute index into the document paragraph list. */
  paragraph_index?: number;
  notes?: string;
  source?: string;
}

export interface ScanResult {
  scan_id: string;
  verdict: string;
  claims: ScanClaim[];
  attestation_enabled?: boolean;
}

// Default to the prod API.  Tests stub this via VITE_VERITIZE_API.
export const API_URL =
  (typeof import.meta !== "undefined"
    ? (import.meta as ImportMeta & { env?: Record<string, string> }).env
        ?.VITE_VERITIZE_API
    : undefined) ?? "https://api.veritize.app";

const SURFACE = "incopy_addin";
const SURFACE_VERSION = "0.1.0";

async function postScanChunk(
  token: string,
  content: string,
): Promise<Response> {
  return fetch(`${API_URL}/v1/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Veritize-Surface": SURFACE,
      "X-Veritize-Surface-Version": SURFACE_VERSION,
    },
    body: JSON.stringify({
      content,
      surface: SURFACE,
      surface_version: SURFACE_VERSION,
    }),
  });
}

/**
 * Scan a single chunk.  On 401 we attempt one refresh-and-retry per
 * VZ-197.  All other non-2xx surface as Error with a user-readable
 * message.
 */
export async function scanOneChunk(
  token: string,
  content: string,
): Promise<ScanResult> {
  let res = await postScanChunk(token, content);

  if (res.status === 401) {
    const refreshed = await refreshOnUnauthorized();
    if (refreshed) {
      res = await postScanChunk(refreshed, content);
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Session expired — sign in again.");
    }
    if (res.status === 402) {
      throw new Error(
        "Scan limit reached on your plan. Upgrade at app.veritize.app/pricing.",
      );
    }
    if (res.status >= 500) {
      throw new Error("Veritize is temporarily unavailable. Retry shortly.");
    }
    const text = await res.text().catch(() => "");
    throw new Error(`scan failed: ${res.status} ${text.slice(0, 200)}`);
  }

  return (await res.json()) as ScanResult;
}

/**
 * Scan a full document by chunking, posting each chunk, and remapping
 * each chunk-relative paragraph_index back to the document-absolute
 * index using the chunk's paragraph_indices list.
 *
 * Returns the flattened claim list across all chunks.  Claims missing
 * `paragraph_index` in the API response are preserved (no remap).
 */
export async function scanChunked(
  token: string,
  paragraphs: DocumentParagraph[],
): Promise<ScanClaim[]> {
  const chunks = chunkParagraphs(paragraphs);
  const all: ScanClaim[] = [];
  for (const chunk of chunks) {
    const res = await scanOneChunk(token, chunk.content);
    for (const claim of res.claims) {
      if (typeof claim.paragraph_index === "number") {
        const idx = claim.paragraph_index;
        if (idx >= 0 && idx < chunk.paragraph_indices.length) {
          all.push({
            ...claim,
            paragraph_index: chunk.paragraph_indices[idx],
          });
          continue;
        }
      }
      all.push(claim);
    }
  }
  return all;
}
