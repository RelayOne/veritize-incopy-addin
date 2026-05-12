// src/document/readParagraphs.ts — read the active InCopy assignment's
// paragraphs via UXP's `require("indesign")` DOM bridge.
//
// Per the spec's "Open questions" section: InCopy assignments are a
// single primary story per assignment file, so `app.activeDocument.
// stories[0].paragraphs` is canonical.  If multi-story assignments
// surface in the field we'll iterate all stories — the helper below
// already does that, just with one story 99% of the time.

import { getInDesign } from "../uxp/host";
import type { InDesignParagraph } from "../uxp/host";

export interface DocumentParagraph {
  /** Zero-based paragraph index across all stories, in story order. */
  index: number;
  /** Paragraph plain text, with trailing newline characters trimmed. */
  text: string;
}

/**
 * Read all non-empty paragraphs from the active document.  Empty
 * paragraphs (whitespace-only) are skipped to match the Word add-in
 * behaviour and to avoid wasting scan budget on blank lines.
 */
export function readDocumentParagraphs(): DocumentParagraph[] {
  const { app } = getInDesign();
  const doc = app.activeDocument;
  if (!doc) return [];
  const out: DocumentParagraph[] = [];
  let i = 0;
  for (const story of doc.stories) {
    for (const para of story.paragraphs) {
      const text = normalizeParagraphText(para);
      if (text.length > 0) {
        out.push({ index: i, text });
      }
      i++;
    }
  }
  return out;
}

function normalizeParagraphText(p: InDesignParagraph): string {
  // InDesign paragraph `contents` strings include a trailing
  // line-terminator (LF, CR, or PS).  Strip trailing whitespace
  // so scan content joins cleanly.
  return p.contents.replace(/\s+$/u, "");
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * A scan chunk: a contiguous range of paragraphs whose total word
 * count fits within the scan endpoint's token budget.  We bias toward
 * fewer, larger chunks (1-2 HTTP calls on a 10-paragraph doc) per
 * VZ-199-2 MUST criterion.
 */
export interface ScanChunk {
  /** Indices of the paragraphs in this chunk, in document order. */
  paragraph_indices: number[];
  /** Joined text, double-newline-separated, ready to POST as `content`. */
  content: string;
  /** Total word count (whitespace-split) for budgeting. */
  word_count: number;
}

/** Spec target: "one HTTP call per ~500-word chunk". */
export const CHUNK_WORD_BUDGET = 500;

/**
 * Group paragraphs into chunks that each stay under wordBudget.  A
 * single paragraph that exceeds the budget becomes its own chunk
 * (rather than splitting mid-paragraph, which would break the
 * paragraph_index -> claim mapping).
 */
export function chunkParagraphs(
  paragraphs: DocumentParagraph[],
  wordBudget = CHUNK_WORD_BUDGET,
): ScanChunk[] {
  const chunks: ScanChunk[] = [];
  let cur: ScanChunk = { paragraph_indices: [], content: "", word_count: 0 };
  for (const p of paragraphs) {
    const w = countWords(p.text);
    if (cur.paragraph_indices.length > 0 && cur.word_count + w > wordBudget) {
      chunks.push(cur);
      cur = { paragraph_indices: [], content: "", word_count: 0 };
    }
    cur.paragraph_indices.push(p.index);
    cur.content = cur.content.length > 0 ? `${cur.content}\n\n${p.text}` : p.text;
    cur.word_count += w;
  }
  if (cur.paragraph_indices.length > 0) chunks.push(cur);
  return chunks;
}

function countWords(s: string): number {
  const t = s.trim();
  if (t.length === 0) return 0;
  return t.split(/\s+/u).length;
}
