# Contributing to PixelQuota

Thanks for helping improve PixelQuota.

## Before opening an issue

- Search existing issues first.
- Use a non-sensitive sample image whenever possible.
- Never upload ID photos, certificates, private forms, medical images, or other confidential files to a public issue.
- Include the browser name/version, operating system, input format, requested KB limit, requested dimensions, and output format when reporting compression problems.

## Local setup

```bash
npm ci
npm run dev
```

Build the production files with:

```bash
npm run build
```

Run the browser validation suite with:

```bash
npm run test:e2e
```

Set `CHROME_PATH` if Chrome/Chromium is installed in a non-standard location.

## Pull requests

Keep pull requests focused. A good PR should:

1. Explain the user problem it solves.
2. Avoid sending image bytes to a server unless the project explicitly changes its privacy model.
3. Preserve English and Traditional Chinese behavior when UI copy changes.
4. Add or update tests for user-visible behavior.
5. Pass the production build and browser tests.
6. Avoid committing `node_modules`, `dist`, test downloads, or private sample files.

## UI changes

PixelQuota is a consumer utility, so readability matters as much as correctness. Check desktop and mobile widths, avoid tiny helper text, and avoid orphaned final words/characters in prominent headings.

## Translation changes

English is the primary repository language. The app itself supports English and Traditional Chinese. New user-facing strings should be added to both locales in the same change.
