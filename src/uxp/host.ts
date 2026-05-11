// src/uxp/host.ts — thin wrapper around the UXP runtime host APIs.
//
// At runtime inside InCopy 2024, `require("indesign")` returns the
// shared InDesign/InCopy DOM root (both apps share the UXP runtime,
// hence the historical "indesign" namespace).  `require("uxp")` exposes
// storage and host-info helpers.
//
// In Vitest we can't actually `require("indesign")` — instead the test
// files monkey-patch this module's `getInDesign` / `getStorage` getters
// to return a fake document tree.  Source code MUST go through these
// helpers; never call `require("indesign")` from feature modules.

export interface InDesignParagraph {
  contents: string;
  // The InCopy paragraph object exposes a select() method that focuses
  // the paragraph in the editor.  We model only what we actually call.
  select?: (mode: number) => void;
  geometricBounds?: [number, number, number, number];
  // Style assignment.  In live InCopy this is an InDesign DOM object;
  // for tests we just store the style name.
  appliedParagraphStyle?: ParagraphStyle | string;
}

export interface InDesignStory {
  paragraphs: InDesignParagraph[];
}

export interface ParagraphStyle {
  name: string;
  fillColor?: Color;
}

export interface Color {
  name: string;
  colorValue?: [number, number, number];
}

export interface InDesignDocument {
  stories: InDesignStory[];
  paragraphStyles: {
    itemByName(name: string): ParagraphStyle | undefined;
    add(props: { name: string; fillColor?: Color }): ParagraphStyle;
  };
  colors: {
    itemByName(name: string): Color | undefined;
    add(props: { name: string; colorValue: [number, number, number] }): Color;
  };
}

export interface InDesignApp {
  activeDocument?: InDesignDocument;
  documents: InDesignDocument[];
  layoutWindow?: {
    activeView: {
      zoomTo(bounds: [number, number, number, number]): void;
    };
  };
}

export interface InDesignRuntime {
  app: InDesignApp;
  // InCopy's SelectionOptions enum.  In the live runtime this is an
  // enum exposed by the indesign module; we only ever use REPLACE_WITH
  // (1145198934 in InDesign DOM, but we treat the value as opaque).
  SelectionOptions: { REPLACE_WITH: unknown };
}

// Internal pointer so tests can swap in a fake.
let _runtime: InDesignRuntime | null = null;

export function setInDesignRuntime(rt: InDesignRuntime | null): void {
  _runtime = rt;
}

interface UXPGlobal {
  require?: (m: string) => unknown;
}

export function getInDesign(): InDesignRuntime {
  if (_runtime) return _runtime;
  // Defer the `require` so test environments that never call this
  // never throw.  In InCopy this resolves to the host-provided module.
  const req = (globalThis as unknown as UXPGlobal).require;
  if (typeof req !== "function") {
    throw new Error(
      "UXP runtime not available: require('indesign') is undefined. " +
        "This module is only importable inside InCopy 2024+ or a test " +
        "that calls setInDesignRuntime() first.",
    );
  }
  _runtime = req("indesign") as InDesignRuntime;
  return _runtime;
}

// UXP `storage.secureStorage` is the recommended place for OAuth
// tokens, but in InCopy 2024 it isn't yet available on all platforms.
// We fall back to localStorage (UXP panels run inside a WebView that
// exposes localStorage scoped to the plugin).
export interface SecureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let _storage: SecureStorage | null = null;

export function setSecureStorage(s: SecureStorage | null): void {
  _storage = s;
}

export function getSecureStorage(): SecureStorage {
  if (_storage) return _storage;
  // Browser/UXP localStorage is synchronous and key/value strings.
  if (typeof localStorage !== "undefined") {
    _storage = {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
      removeItem: (k) => localStorage.removeItem(k),
    };
    return _storage;
  }
  throw new Error("No storage available (no localStorage and no fake set).");
}
