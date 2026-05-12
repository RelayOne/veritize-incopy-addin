// Tests for src/document/highlight.ts.
//
// We mock the UXP runtime via setInDesignRuntime() in beforeEach so each
// test gets a clean fake document. The tests cover:
//   - paragraph styles + colors are created on first use, reused after
//   - claim → paragraph mapping respects the same empty-paragraph skip
//     rule as readParagraphs (the index returned by /v1/scan refers to
//     the post-skip list)
//   - applyVerdictHighlights silently ignores claims with no
//     paragraph_index, unknown verdicts, or no active document
//   - scrollToClaim selects + zooms; no-ops if doc / layoutWindow absent
//
// No I/O, no real InCopy required. Run with `npm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyVerdictHighlights,
  scrollToClaim,
} from "../document/highlight";
import {
  setInDesignRuntime,
  type Color,
  type InDesignDocument,
  type InDesignParagraph,
  type InDesignRuntime,
  type InDesignStory,
  type ParagraphStyle,
} from "../uxp/host";
import type { ScanClaim } from "../api/scan";

function makeParagraph(contents: string): InDesignParagraph {
  const p: InDesignParagraph = {
    contents,
    select: vi.fn(),
    geometricBounds: [0, 0, 10, 100],
  };
  return p;
}

function makeStory(paragraphs: InDesignParagraph[]): InDesignStory {
  return { paragraphs };
}

interface FakeDocState {
  doc: InDesignDocument;
  colors: Map<string, Color>;
  styles: Map<string, ParagraphStyle>;
  zoomCalls: Array<[number, number, number, number]>;
}

function makeFakeDoc(stories: InDesignStory[]): FakeDocState {
  const colors = new Map<string, Color>();
  const styles = new Map<string, ParagraphStyle>();
  const zoomCalls: Array<[number, number, number, number]> = [];
  const doc: InDesignDocument = {
    stories,
    colors: {
      itemByName(name) {
        return colors.get(name);
      },
      add(props) {
        const c: Color = { name: props.name, colorValue: props.colorValue };
        colors.set(props.name, c);
        return c;
      },
    },
    paragraphStyles: {
      itemByName(name) {
        return styles.get(name);
      },
      add(props) {
        const s: ParagraphStyle = {
          name: props.name,
          fillColor: props.fillColor,
        };
        styles.set(props.name, s);
        return s;
      },
    },
  };
  return { doc, colors, styles, zoomCalls };
}

function installRuntime(doc: InDesignDocument | undefined, zoomCalls?: Array<[number, number, number, number]>): void {
  const runtime: InDesignRuntime = {
    app: {
      activeDocument: doc,
      documents: doc ? [doc] : [],
      layoutWindow: {
        activeView: {
          zoomTo(bounds) {
            zoomCalls?.push(bounds);
          },
        },
      },
    },
    SelectionOptions: { REPLACE_WITH: 1145198934 },
  };
  setInDesignRuntime(runtime);
}

afterEach(() => {
  setInDesignRuntime(null);
});

describe("applyVerdictHighlights", () => {
  it("creates a paragraph style with the verdict color attached, end-to-end", () => {
    const p0 = makeParagraph("Earth orbits the Sun.");
    const p1 = makeParagraph("The moon is made of cheese.");
    const state = makeFakeDoc([makeStory([p0, p1])]);
    installRuntime(state.doc);

    applyVerdictHighlights([
      { id: "c1", claim_text: "Earth orbits the Sun.", verdict: "verified", confidence: 0.99, paragraph_index: 0 },
      { id: "c2", claim_text: "The moon is made of cheese.", verdict: "disputed", confidence: 0.95, paragraph_index: 1 },
    ]);

    // The end-to-end assertion: each paragraph carries a style whose
    // fillColor's RGB matches the verdict palette. This couples the test
    // to the contract callers see (the InDesign doc model) rather than
    // to map-bookkeeping internals.
    const greenStyle = p0.appliedParagraphStyle as ParagraphStyle;
    const redStyle = p1.appliedParagraphStyle as ParagraphStyle;
    expect(greenStyle.name).toBe("VeritizeVerdict-Verified");
    expect(greenStyle.fillColor?.colorValue).toEqual([22, 163, 74]);
    expect(redStyle.name).toBe("VeritizeVerdict-Disputed");
    expect(redStyle.fillColor?.colorValue).toEqual([220, 38, 38]);
  });

  it("reuses existing styles + colors on subsequent runs", () => {
    const state = makeFakeDoc([
      makeStory([makeParagraph("Earth orbits the Sun.")]),
    ]);
    installRuntime(state.doc);

    applyVerdictHighlights([
      { id: "c1", claim_text: "x", verdict: "verified", confidence: 0.9, paragraph_index: 0 },
    ]);
    const colorBefore = state.colors.get("Veritize-Green");
    const styleBefore = state.styles.get("VeritizeVerdict-Verified");

    applyVerdictHighlights([
      { id: "c2", claim_text: "y", verdict: "verified", confidence: 0.9, paragraph_index: 0 },
    ]);
    expect(state.colors.get("Veritize-Green")).toBe(colorBefore);
    expect(state.styles.get("VeritizeVerdict-Verified")).toBe(styleBefore);
  });

  it("assigns the style on the targeted paragraph and only that paragraph", () => {
    const p0 = makeParagraph("Earth orbits the Sun.");
    const p1 = makeParagraph("The moon is made of cheese.");
    const state = makeFakeDoc([makeStory([p0, p1])]);
    installRuntime(state.doc);

    applyVerdictHighlights([
      { id: "c1", claim_text: "x", verdict: "verified", confidence: 0.9, paragraph_index: 1 },
    ]);
    expect(p0.appliedParagraphStyle).toBeUndefined();
    expect(p1.appliedParagraphStyle).toBeDefined();
    const applied = p1.appliedParagraphStyle as ParagraphStyle;
    expect(applied.name).toBe("VeritizeVerdict-Verified");
  });

  it("treats empty / whitespace paragraphs as not part of the scan index", () => {
    const p0 = makeParagraph("Earth orbits the Sun.");
    const pBlank = makeParagraph("   \n");
    const p1 = makeParagraph("The moon is made of cheese.");
    const state = makeFakeDoc([makeStory([p0, pBlank, p1])]);
    installRuntime(state.doc);

    // paragraph_index=1 should map to p1, not the blank one, because the
    // /v1/scan response uses the post-skip index just like
    // readParagraphs does.
    applyVerdictHighlights([
      { id: "c1", claim_text: "x", verdict: "disputed", confidence: 0.9, paragraph_index: 1 },
    ]);
    expect(p0.appliedParagraphStyle).toBeUndefined();
    expect(pBlank.appliedParagraphStyle).toBeUndefined();
    expect(p1.appliedParagraphStyle).toBeDefined();
  });

  it("silently no-ops when paragraph_index is missing or out of range", () => {
    const p0 = makeParagraph("Earth orbits the Sun.");
    const state = makeFakeDoc([makeStory([p0])]);
    installRuntime(state.doc);

    applyVerdictHighlights([
      { id: "c1", claim_text: "x", verdict: "verified", confidence: 0.9 },
      { id: "c2", claim_text: "y", verdict: "verified", confidence: 0.9, paragraph_index: 99 },
    ]);
    expect(p0.appliedParagraphStyle).toBeUndefined();
    expect(state.colors.size).toBe(0);
    expect(state.styles.size).toBe(0);
  });

  it("silently no-ops when no active document", () => {
    installRuntime(undefined);
    let threw = false;
    try {
      applyVerdictHighlights([
        { id: "c1", claim_text: "x", verdict: "verified", confidence: 0.9, paragraph_index: 0 },
      ]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("scrollToClaim", () => {
  it("selects the paragraph and zooms to its bounds", () => {
    const p0 = makeParagraph("Earth orbits the Sun.");
    const p1 = makeParagraph("The moon is made of cheese.");
    p1.geometricBounds = [10, 20, 30, 200];
    const state = makeFakeDoc([makeStory([p0, p1])]);
    installRuntime(state.doc, state.zoomCalls);

    scrollToClaim({
      id: "c2",
      claim_text: "y",
      verdict: "disputed",
      confidence: 0.9,
      paragraph_index: 1,
    });

    expect(p0.select).not.toHaveBeenCalled();
    expect(p1.select).toHaveBeenCalledWith(1145198934);
    expect(state.zoomCalls).toEqual([[10, 20, 30, 200]]);
  });

  it("no-ops on missing paragraph_index", () => {
    const p0 = makeParagraph("x");
    const state = makeFakeDoc([makeStory([p0])]);
    installRuntime(state.doc, state.zoomCalls);
    scrollToClaim({
      id: "c1",
      claim_text: "x",
      verdict: "verified",
      confidence: 0.9,
    });
    expect(p0.select).not.toHaveBeenCalled();
    expect(state.zoomCalls).toEqual([]);
  });

  it("no-ops on missing active document", () => {
    installRuntime(undefined);
    let threw = false;
    try {
      scrollToClaim({
        id: "c1",
        claim_text: "x",
        verdict: "verified",
        confidence: 0.9,
        paragraph_index: 0,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
