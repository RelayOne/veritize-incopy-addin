// VZ-199-1 — UXP plugin manifest invariants.
//
// The manifest.json shape is brittle: the wrong manifestVersion or host id
// makes InCopy silently skip the plugin.  These tests pin the values that
// Adobe's UXP 2024 documentation requires for InCopy 19.0+.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, "..", "..", "manifest.json");

interface Manifest {
  id: string;
  name: string;
  version: string;
  main: string;
  manifestVersion: number;
  host: Array<{ app: string; minVersion: string }>;
  entrypoints: Array<{ type: string; id: string; label: { default: string } }>;
  requiredPermissions?: { network?: { domains?: string[] } };
}

function loadManifest(): Manifest {
  const raw = fs.readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as Manifest;
}

describe("manifest.json (VZ-199-1)", () => {
  it("declares manifestVersion 6 (UXP 2024)", () => {
    const m = loadManifest();
    expect(m.manifestVersion).toBe(6);
  });

  it("targets host.app === 'incopy' (NOT 'indesign')", () => {
    const m = loadManifest();
    expect(m.host[0].app).toBe("incopy");
  });

  it("pins minVersion >= 19.0 (first UXP-only InCopy)", () => {
    const m = loadManifest();
    const [major] = m.host[0].minVersion.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(19);
  });

  it("exposes a panel entrypoint id=veritize-panel labelled 'Veritize'", () => {
    const m = loadManifest();
    const panel = m.entrypoints.find((e) => e.type === "panel");
    expect(panel).toBeDefined();
    expect(panel!.id).toBe("veritize-panel");
    expect(panel!.label.default).toBe("Veritize");
  });

  it("permits network access to app.dev.veritize.app (OAuth issuer in dev)", () => {
    const m = loadManifest();
    const domains = m.requiredPermissions?.network?.domains ?? [];
    expect(domains).toContain("https://app.dev.veritize.app");
  });

  it("permits network access to api.veritize.app (prod scan endpoint)", () => {
    const m = loadManifest();
    const domains = m.requiredPermissions?.network?.domains ?? [];
    expect(domains).toContain("https://api.veritize.app");
  });

  it("uses a unique plugin id (app.veritize.incopy reverse-DNS)", () => {
    const m = loadManifest();
    expect(m.id).toBe("app.veritize.incopy");
  });
});
