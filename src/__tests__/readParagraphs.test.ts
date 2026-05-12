// VZ-199-2 — paragraph read + chunking tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readDocumentParagraphs,
  chunkParagraphs,
  CHUNK_WORD_BUDGET,
} from "../document/readParagraphs";
import { setInDesignRuntime } from "../uxp/host";
import type {
  InDesignRuntime,
  InDesignParagraph,
  InDesignDocument,
} from "../uxp/host";

function paragraph(contents: string): InDesignParagraph {
  return { contents };
}

function buildDoc(paragraphs: InDesignParagraph[]): InDesignDocument {
  return {
    stories: [{ paragraphs }],
    paragraphStyles: {
      itemByName: () => undefined,
      add: (p) => ({ name: p.name, fillColor: p.fillColor }),
    },
    colors: {
      itemByName: () => undefined,
      add: (p) => ({ name: p.name, colorValue: p.colorValue }),
    },
  };
}

function buildRuntime(doc: InDesignDocument | undefined): InDesignRuntime {
  return {
    app: { activeDocument: doc, documents: doc ? [doc] : [] },
    SelectionOptions: { REPLACE_WITH: Symbol("REPLACE_WITH") },
  };
}

afterEach(() => {
  setInDesignRuntime(null);
});

describe("readDocumentParagraphs (VZ-199-2)", () => {
  it("returns [] when no active document", () => {
    setInDesignRuntime(buildRuntime(undefined));
    expect(readDocumentParagraphs()).toStrictEqual([]);
  });

  it("emits one entry per non-empty paragraph with sequential indices", () => {
    const doc = buildDoc([
      paragraph("First para."),
      paragraph("Second para."),
      paragraph("Third para."),
    ]);
    setInDesignRuntime(buildRuntime(doc));
    const out = readDocumentParagraphs();
    expect(out.map((p) => p.index)).toStrictEqual([0, 1, 2]);
    expect(out.map((p) => p.text)).toStrictEqual([
      "First para.",
      "Second para.",
      "Third para.",
    ]);
  });

  it("skips empty/whitespace paragraphs but preserves source indices", () => {
    const doc = buildDoc([
      paragraph("Hello."),
      paragraph("   \n"),
      paragraph("World."),
    ]);
    setInDesignRuntime(buildRuntime(doc));
    const out = readDocumentParagraphs();
    // Index 1 was whitespace -> skipped.  Index 0 and 2 remain.
    expect(out).toStrictEqual([
      { index: 0, text: "Hello." },
      { index: 2, text: "World." },
    ]);
  });

  it("trims trailing newlines from InDesign paragraph contents", () => {
    const doc = buildDoc([paragraph("Hello world.\r\n")]);
    setInDesignRuntime(buildRuntime(doc));
    expect(readDocumentParagraphs()[0].text).toStrictEqual("Hello world.");
  });

  it("walks multiple stories preserving cross-story index", () => {
    const doc: InDesignDocument = {
      stories: [
        { paragraphs: [paragraph("A.")] },
        { paragraphs: [paragraph("B."), paragraph("C.")] },
      ],
      paragraphStyles: { itemByName: () => undefined, add: (p) => ({ name: p.name }) },
      colors: {
        itemByName: () => undefined,
        add: (p) => ({ name: p.name, colorValue: p.colorValue }),
      },
    };
    setInDesignRuntime(buildRuntime(doc));
    const out = readDocumentParagraphs();
    expect(out).toStrictEqual([
      { index: 0, text: "A." },
      { index: 1, text: "B." },
      { index: 2, text: "C." },
    ]);
  });
});

describe("chunkParagraphs (VZ-199-2)", () => {
  it("fits a 10-paragraph short document into 1 chunk", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      text: `Sentence number ${i} short.`, // 4-5 words each
    }));
    const chunks = chunkParagraphs(paragraphs);
    expect(chunks.length).toBe(1);
    expect(chunks[0].paragraph_indices).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("splits when the 500-word budget overflows; produces 2 chunks for 600 words", () => {
    const para = (idx: number, words: number): { index: number; text: string } => ({
      index: idx,
      text: Array.from({ length: words }, (_, i) => `w${i}`).join(" "),
    });
    // Two paragraphs of 300 words each = 600 total > 500.  Expect 2 chunks.
    const chunks = chunkParagraphs([para(0, 300), para(1, 300)]);
    expect(chunks.length).toBe(2);
    expect(chunks[0].paragraph_indices).toStrictEqual([0]);
    expect(chunks[1].paragraph_indices).toStrictEqual([1]);
  });

  it("keeps an oversize single paragraph as its own chunk (does not split mid-paragraph)", () => {
    const huge = {
      index: 0,
      text: Array.from({ length: 800 }, (_, i) => `w${i}`).join(" "),
    };
    const chunks = chunkParagraphs([huge]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].paragraph_indices).toStrictEqual([0]);
    expect(chunks[0].word_count).toBeGreaterThan(CHUNK_WORD_BUDGET);
  });

  it("double-newline-separates joined chunk content", () => {
    const chunks = chunkParagraphs([
      { index: 0, text: "First." },
      { index: 1, text: "Second." },
    ]);
    expect(chunks[0].content).toStrictEqual("First.\n\nSecond.");
  });

  it("returns [] for empty input", () => {
    expect(chunkParagraphs([])).toStrictEqual([]);
  });
});
