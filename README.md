# Veritize — Adobe InCopy add-in

UXP plugin that brings Veritize content verification into Adobe InCopy 2024+. Sibling to the [Word add-in](https://github.com/RelayOne/veritize-word-addin) and the [Google Docs add-in](https://github.com/RelayOne/veritize-gdocs-addin).

Editorial workflows in publishing live in Adobe InCopy more than in Word: editors send InCopy assignments back-and-forth with InDesign layout files. This plugin extends Veritize's per-claim verification into that editorial chain.

## Status

Tasks 1-5 of 8 shipped (52 tests pass). Tasks 6-8 are operator-side:

- **6** Cloudflare Pages deploy at `incopy.veritize.app` (project + DNS CNAME)
- **7** `.ccx` packaging via Adobe `uxp-cli`
- **8** Adobe Exchange submission

Until those land, install via the UXP Developer Tool by sideloading the local build (see Dev workflow below).

## What's in the plugin

- **UXP plugin scaffold** (manifest v6, InCopy 19.0+) — Vite + React 19 + TypeScript, panel entrypoint, Node 20.
- **Paragraph-chunked scan** via `require("indesign")` bridge. Walks `app.activeDocument.stories[i].paragraphs`, packs into ≤500-word chunks, POSTs each chunk to `/v1/scan` with the OAuth Bearer token, maps responses back to absolute paragraph indices.
- **Verdict-color paragraph-style highlights.** Plugin auto-creates four named paragraph styles on first run (`VeritizeVerdict-{Verified,Disputed,Unverified,Insufficient}`) with their associated fill colors; assigns each scanned paragraph the matching style. Highlights persist when the document is saved/reopened (paragraph styles are part of the doc model).
- **Scroll-to-claim.** Each claim card has a "Show in document" button that selects the source paragraph and zooms the layout view to its bounds.
- **OAuth PKCE sign-in** via in-panel iframe against the VZ-197 OAuth 2.1 server. Tokens persisted in UXP `secureStorage` with localStorage fallback. Refresh-on-401 + revocation supported.

## Install (preview, sideload)

1. Install [Adobe UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/devtool/) on macOS or Windows.
2. Clone this repo and build:
   ```bash
   nvm use 20
   npm install
   npm run build
   ```
3. In UXP Developer Tool, add a plugin pointing at this directory and click **Load** with InCopy 2024 running.
4. In InCopy, open **Window → Extensions → Veritize**. Sign in with your Veritize account.

## Dev workflow

```bash
nvm use 20
npm install
npm run dev      # vite dev server for the panel UI
npm test         # vitest — 52 tests pass on Node 20
npm run build    # tsc --noEmit && vite build → dist/
```

## Repo layout

```
src/
  panel/        — top-level React panel UI
  document/     — readParagraphs + highlight (the doc-model surface)
  api/          — /v1/scan wrapper + chunk batching
  auth/         — OAuth PKCE flow + token persistence
  uxp/          — UXP runtime abstraction (mockable for tests)
  __tests__/    — vitest suite (mocks UXP DOM)
manifest.json   — UXP plugin manifest (v6, host=incopy 19.0+)
audit/          — operator-handoff docs (Cloudflare, Adobe Exchange, OAuth client seed)
```

## OAuth client registration

When the operator wires this into production, register a new OAuth client `veritize-incopy-addin` in `RelayOne/veritize-app#db/seed-oauth-clients.sql` per `audit/oauth-client-registration.md` in this repo.

## See also

- Cross-link: [`RelayOne/veritize`](https://github.com/RelayOne/veritize) (Go core + product docs)
- Sibling editor add-ins: [`veritize-word-addin`](https://github.com/RelayOne/veritize-word-addin), [`veritize-gdocs-addin`](https://github.com/RelayOne/veritize-gdocs-addin)

## License

FSL-1.1-Apache-2.0 (Functional Source License, Apache 2.0 conversion clause). See `LICENSE`.
