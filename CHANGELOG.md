# Changelog

## 1.5.0 - 2026-09-26

### New

- SVG Pro: new vectorizer for logos, icons and flat graphics. Each color becomes one clean path, with straight edges and sharp corners kept, fine hairline strokes preserved, and linear or radial gradients exported as real SVG gradients. Single-color logos stay a single color. Settings are chosen automatically.
- Social Crop: added Threads, TikTok and Pinterest, plus Instagram 1:1 and the 3:4 Reels cover.

### Changes

- Remove Background now runs on the AI model only; the quick mode and manual sliders are gone, and the panel shows just the model name and its status.
- New headline and a short one-line description for every tool, in all five languages.
- Removed the top navigation, highlight pills, the guide section, the duplicate logo inside the tool window, and several secondary hints.
- Larger text for the tool switcher and other small labels; lighter bold weights; text inputs now use the page font.
- The privacy note moved below the settings column so it no longer sits inside the workspace.
- More consistent spacing between panels and above the footer.

## 1.4.2 — 2026-09-25

### Fixes

- Changing a setting while a batch is processing no longer commits results built with the old settings; the run stops and asks to be run again.
- Automatic output format now checks every pixel for transparency, so images with small transparent areas are no longer exported as JPG.
- Exporting a transparent image as JPG now fills transparent areas with white instead of black.
- Unchecking "Remove EXIF and location" now keeps the original EXIF block on JPG-to-JPG output (orientation tag reset, since pixels are already rotated). Other output formats still drop metadata, and EXIF is dropped when it would take more than half of a KB limit.
- Images or output sizes beyond browser canvas limits now fail with a clear message instead of a generic error.
- ZIP downloads no longer drop files when two outputs share a name; duplicates get a numbered suffix.
- Released decoded image memory after compression and when removing files from Remove Background.

### Accessibility

- Tool, format, resize, redaction, crop and engine button groups now expose the current selection with `aria-pressed`.
- The Privacy page language menu now exposes its options and current selection to assistive technology.

### Build

- Declared `esbuild` as a direct dev dependency; the build script imports it and previously relied on Vite installing it indirectly, which broke the Vite 8 upgrade.
- Removed the unused `scripts/postbuild.mjs`, which no longer matched the inlined build output.

## 1.4.1 — 2026-09-20

### Compression and conversion

- Replaced browser-dependent Canvas AVIF output with a bundled local WebAssembly AVIF encoder, so AVIF export no longer depends on native browser encoding support and never requires uploading image bytes.
- Added regression coverage for real AVIF signatures, conversion-only output, exact-KB AVIF compression, and zero runtime AVIF WASM network requests.

### UX

- Kept the browser tab title stable while switching between Compress, Watermark, Redact, Social Crop, and Remove Background.
- Preserved dedicated titles for exact-KB and HEIC-to-JPG landing-page routes while tool switching no longer rewrites page metadata.


## 1.4.0 — 2026-09-19

### New tools

- Expanded PixelQuota from an exact-KB compressor into a five-tool browser image workspace.
- Added text and image watermarking with independent positioning, opacity, sizing, presets, live preview, and full-resolution export.
- Added manual sensitive-content redaction with pixelate, blur, and solid-block regions, per-image layers, undo / redo, move / resize editing, and an exported before/after comparison.
- Added social-platform cropping with platform-specific size groups and direct manual crop framing instead of fixed focal-point guesses.
- Added local background removal with a quick mode and an AI Precision mode powered by BiRefNet Lite 512.

### Compression and conversion

- Combined compression and format conversion into one workflow.
- Added a conversion-only mode that preserves source pixel dimensions without forcing a KB target.
- Added browser-gated AVIF output and a local BMP encoder alongside JPG, PNG, WebP, and automatic output selection.
- Kept exact KB targets, exact / bounded dimensions, HEIC / HEIF decoding, metadata removal, batch processing, and ZIP export.

### Local AI and privacy

- AI background removal downloads model files only; selected image bytes are never uploaded.
- Added an IndexedDB-backed model cache so the BiRefNet model can be reused after refresh without downloading the weights again.
- AI refinement reuses the cached matte instead of rerunning the model for every threshold / feather adjustment.
- Added clear AI processing states and exact error details instead of silent fallback behavior.
- Added an enlarged edge-inspection view for checking hair and transparent boundaries at 100%, 200%, or 400% without another AI inference.

### Workflow and UX

- Added output-before-download safeguards across processing tools: download controls appear only after the current settings have been exported.
- Added per-file result removal while keeping batch state synchronized.
- Preserved natural image orientation and equal preview padding for portrait, landscape, and square images.
- Removed native-looking language controls and expanded the main UI to English, Traditional Chinese, Simplified Chinese, Japanese, and Korean.
- Improved range controls, responsive spacing, centered segmented controls, and result-card switching without preview flashes.
- Background-removal previews now show an explicit processing overlay while AI work is in progress.

### Fixes and performance

- Removed the experimental Smart Redaction feature after browser capability testing showed inconsistent real-world usefulness.
- Fixed redaction export mode so users can return from before/after comparison to editable regions and re-export safely.
- Coalesced watermark and background-removal preview updates to reduce UI stalls during slider changes.
- Hardened the standalone build pipeline against bundled JavaScript containing replacement-string tokens such as `$&`.

## 1.3.3 — 2026-09-17

- Fixed the empty red failure banner appearing beneath successful before/after previews.
- Added regression coverage to ensure successful results keep the failure message fully hidden.

## 1.3.2 — 2026-09-17

- Moved the processed-image list beside the large before/after preview on desktop for a denser, cleaner result workspace.
- Added a fixed-height, vertically scrollable result list for larger batches.
- Kept the selected-file interaction intact: choosing a result row updates the large comparison preview.
- Preserved the stacked preview-then-list layout on tablets and phones.

## 1.3.1 — 2026-09-17

- Added a draggable Original / Compressed comparison as the primary result preview.
- Added result-row selection so batch files can be switched into the large comparison preview.
- Defaulted the comparison to the first result that successfully meets the target.
- Failed results now show the original preview with the localized failure reason instead of a misleading comparison slider.
- Added touch, mouse, and keyboard-friendly comparison controls while preserving existing compression and batch behavior.

## 1.3.0 — 2026-09-17

- Rebuilt the desktop interface around a short centered hero and a full-width workspace.
- Kept the headline on one line on desktop while preserving responsive wrapping on smaller screens.
- Expanded the results area and moved upload/output controls into a dedicated left column.
- Refreshed the visual system with the blue/white PixelQuota product style while preserving all compression, HEIC, batch ZIP, metadata removal, localization, exact-size, and repeat-processing behavior.
- Added explicit empty-result and local-processing states to make the workflow clearer before files are selected.

## 1.2.1 — 2026-09-17

- Improved English and Traditional Chinese heading wrapping with balanced typography.
- Added automated typography checks across 320, 375, 768, 1024, and 1440 px widths.
- Added cross-platform Chrome/Chromium detection for browser tests.
- Prepared the project for a public GitHub release with CI, Pages deployment, contribution docs, issue forms, and bilingual READMEs.

## 1.2.0

- Added complete English / Traditional Chinese UI switching.
- Added custom KB targets and common-limit buttons.
- Added clear localized failure explanations.
- Added repeat-processing protection and original-file reprocessing after setting changes.
- Removed camera capture and duplicate local launch entry points.
- Improved spacing and readability across desktop and mobile layouts.
