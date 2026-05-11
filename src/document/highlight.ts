// src/document/highlight.ts — apply per-verdict paragraph-style highlights
// inside the active InCopy document, and scroll the editor to a claim's
// paragraph when the user clicks "Show in document".
//
// Highlights use named paragraph styles ("VeritizeVerdict-Verified",
// "VeritizeVerdict-Unverified", "VeritizeVerdict-Disputed",
// "VeritizeVerdict-InsufficientEvidence") with distinct fill colors that
// the plugin creates on first run if they don't already exist. This way
// the highlights persist when the document is saved/reopened (paragraph
// styles are part of the doc model, unlike runtime overlays).
//
// Why this file is separate from readParagraphs.ts: reading the document
// is read-only and safe to call from tests; applying styles touches the
// host's mutable doc model and we want a separate surface to mock.
//
// VZ-199-3 / VZ-199-4 in the spec.

import { getInDesign } from "../uxp/host";
import type {
  Color,
  InDesignDocument,
  ParagraphStyle,
} from "../uxp/host";
import type { ScanClaim, Verdict } from "../api/scan";

// Verdict → style + color triple. Colors picked to match the Word add-in
// palette: green (verified), red (disputed), amber (unverified), gray
// (insufficient_evidence). Values are RGB triples in 0-255 space —
// InDesign accepts that for `colorValue`.
interface StyleSpec {
  styleName: string;
  colorName: string;
  rgb: [number, number, number];
}

const STYLE_SPECS: Record<Verdict, StyleSpec> = {
  verified: {
    styleName: "VeritizeVerdict-Verified",
    colorName: "Veritize-Green",
    rgb: [22, 163, 74],
  },
  disputed: {
    styleName: "VeritizeVerdict-Disputed",
    colorName: "Veritize-Red",
    rgb: [220, 38, 38],
  },
  unverified: {
    styleName: "VeritizeVerdict-Unverified",
    colorName: "Veritize-Amber",
    rgb: [161, 98, 7],
  },
  insufficient_evidence: {
    styleName: "VeritizeVerdict-Insufficient",
    colorName: "Veritize-Gray",
    rgb: [107, 114, 128],
  },
};

function ensureColor(doc: InDesignDocument, spec: StyleSpec): Color {
  const existing = doc.colors.itemByName(spec.colorName);
  if (existing) return existing;
  return doc.colors.add({ name: spec.colorName, colorValue: spec.rgb });
}

function ensureStyle(
  doc: InDesignDocument,
  spec: StyleSpec,
): ParagraphStyle {
  const existing = doc.paragraphStyles.itemByName(spec.styleName);
  if (existing) return existing;
  const fillColor = ensureColor(doc, spec);
  return doc.paragraphStyles.add({ name: spec.styleName, fillColor });
}

/**
 * Apply per-paragraph highlight styles based on claim verdicts.
 *
 * For each claim with a resolved `paragraph_index`, look up the paragraph
 * across all stories (in story order) and assign the matching paragraph
 * style. Claims without an index are silently skipped — that's the
 * extractor's fault, not the renderer's.
 */
export function applyVerdictHighlights(claims: readonly ScanClaim[]): void {
  const { app } = getInDesign();
  const doc = app.activeDocument;
  if (!doc) return;
  // Build the same flat paragraph index that readParagraphs uses (story
  // order, then within-story order). Empty paragraphs in readParagraphs
  // are skipped, but the index that came back from /v1/scan refers to the
  // post-skip list; we mirror that here.
  const flat: Array<{ index: number; paragraph: typeof doc.stories[number]["paragraphs"][number] }> = [];
  let i = 0;
  for (const story of doc.stories) {
    for (const paragraph of story.paragraphs) {
      const text = (paragraph.contents ?? "").replace(/[\r\n]+$/g, "");
      if (text.trim().length === 0) continue;
      flat.push({ index: i, paragraph });
      i += 1;
    }
  }
  const byIndex = new Map(flat.map(({ index, paragraph }) => [index, paragraph]));
  for (const claim of claims) {
    if (typeof claim.paragraph_index !== "number") continue;
    const paragraph = byIndex.get(claim.paragraph_index);
    if (!paragraph) continue;
    const spec = STYLE_SPECS[claim.verdict];
    if (!spec) continue;
    const style = ensureStyle(doc, spec);
    paragraph.appliedParagraphStyle = style;
  }
}

/**
 * Select + zoom to the paragraph carrying this claim. Best-effort:
 * silently no-op if the runtime doesn't expose layoutWindow (e.g. the
 * doc is open but no editor view is active).
 */
export function scrollToClaim(claim: ScanClaim): void {
  if (typeof claim.paragraph_index !== "number") return;
  const { app, SelectionOptions } = getInDesign();
  const doc = app.activeDocument;
  if (!doc) return;
  // Same flattening as applyVerdictHighlights — keep them in lock-step.
  let i = 0;
  for (const story of doc.stories) {
    for (const paragraph of story.paragraphs) {
      const text = (paragraph.contents ?? "").replace(/[\r\n]+$/g, "");
      if (text.trim().length === 0) continue;
      if (i === claim.paragraph_index) {
        if (typeof paragraph.select === "function") {
          paragraph.select(SelectionOptions.REPLACE_WITH as number);
        }
        if (paragraph.geometricBounds && app.layoutWindow) {
          app.layoutWindow.activeView.zoomTo(paragraph.geometricBounds);
        }
        return;
      }
      i += 1;
    }
  }
}
