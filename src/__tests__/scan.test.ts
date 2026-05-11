// VZ-199-2 — /v1/scans POST + chunked scan with paragraph remap.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scanOneChunk, scanChunked, API_URL } from "../api/scan";

const originalFetch = globalThis.fetch;
const fetchMock = (): ReturnType<typeof vi.fn> =>
  globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

function mockOk(body: unknown): void {
  fetchMock().mockResolvedValueOnce({ ok: true, json: async () => body });
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Build a 6-paragraph doc where each paragraph is 200 words (forces
 * each into its own chunk under the 500-word budget).  Mock chunk 0
 * to return claim c1 with paragraph_index=1 (out-of-range -> kept).
 * Mock chunk 1 to return claim c2 with paragraph_index=0 (rel idx 0
 * in chunk 1 -> abs idx 1).
 */
async function runRemapScenario(): Promise<{ c1?: number; c2?: number; total: number }> {
  // 300-word paragraphs ensure each lands in its own chunk under the
  // 500-word budget (first paragraph 300 fits; second would be 600
  // which exceeds, forcing a flush).
  const longText = (n: number): string =>
    Array.from({ length: 300 }, (_, i) => `w${i}_${n}`).join(" ");
  const paragraphs = Array.from({ length: 6 }, (_, i) => ({ index: i, text: longText(i) }));
  mockOk({
    scan_id: "s1", verdict: "v",
    claims: [{ id: "c1", claim_text: "a", verdict: "verified", confidence: 0.9, paragraph_index: 1 }],
  });
  mockOk({
    scan_id: "s2", verdict: "v",
    claims: [{ id: "c2", claim_text: "b", verdict: "disputed", confidence: 0.7, paragraph_index: 0 }],
  });
  for (let i = 0; i < 4; i++) mockOk({ scan_id: `s${i + 3}`, verdict: "v", claims: [] });
  const claims = await scanChunked("t", paragraphs);
  const byId: Record<string, number | undefined> = {};
  for (const c of claims) byId[c.id] = c.paragraph_index;
  return { c1: byId.c1, c2: byId.c2, total: claims.length };
}

describe("scanOneChunk (VZ-199-2)", () => {
  it("POSTs to /v1/scans with bearer auth + incopy_addin surface headers", async () => {
    mockOk({ scan_id: "s1", verdict: "verified", claims: [] });
    await scanOneChunk("ver_test", "Hello.");
    const call = fetchMock().mock.calls[0];
    expect(call[0]).toBe(`${API_URL}/v1/scans`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ver_test");
    expect(headers["X-Veritize-Surface"]).toBe("incopy_addin");
  });

  it("surfaces 401 as session-expired (after refresh fails)", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    await expect(scanOneChunk("t", "x")).rejects.toThrow(/sign in again/i);
  });

  it("surfaces 402 as plan-upgrade prompt", async () => {
    fetchMock().mockResolvedValueOnce({ ok: false, status: 402, text: async () => "" });
    await expect(scanOneChunk("t", "x")).rejects.toThrow(/Scan limit reached/);
  });

  it("surfaces 5xx as temporary-unavailable", async () => {
    fetchMock().mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" });
    await expect(scanOneChunk("t", "x")).rejects.toThrow(/temporarily unavailable/);
  });
});

describe("scanChunked paragraph_index remap (VZ-199-2 MUST)", () => {
  it("remaps chunk-relative paragraph_index back to document-absolute index", async () => {
    const { c1, c2, total } = await runRemapScenario();
    expect(c1).toBe(1); // out-of-range -> kept as-is
    expect(c2).toBe(1); // rel 0 in chunk 1 -> abs 1
    expect(total).toBe(2);
  });

  it("MUST: 10-paragraph short doc fits in 1 chunk and remaps 1:1", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      text: `Paragraph ${i} content here.`,
    }));
    mockOk({
      scan_id: "s", verdict: "v",
      claims: [
        { id: "c", claim_text: "x", verdict: "verified", confidence: 1, paragraph_index: 5 },
      ],
    });
    const claims = await scanChunked("t", paragraphs);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    // Chunk-relative idx 5 in a single chunk spanning paragraphs 0..9
    // -> absolute index 5 (1:1, no off-by-one).
    expect(claims[0].paragraph_index).toBe(5);
  });
});
