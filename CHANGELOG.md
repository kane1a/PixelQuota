# Changelog

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
