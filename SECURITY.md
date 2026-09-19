# Security Policy

## Supported version

Security fixes are applied to the latest version on `main`.

## Reporting a vulnerability

Please do not publish security vulnerabilities, exploit details, or sensitive image samples in a public issue.

Use GitHub's private vulnerability reporting / Security Advisory flow for this repository when available. Include a minimal reproduction, affected browser/version, and the expected security boundary.

PixelQuota is intended to process selected image bytes locally in the browser. Any unexpected network transmission of selected image data, arbitrary code execution, unsafe file handling, or dependency compromise should be treated as a high-priority security issue.

## Privacy boundary

The project has no image-upload endpoint. AI background removal may download model files, but those requests must remain independent from selected image bytes: images must never be attached to model downloads or sent to a remote inference service. Optional advertising or sponsor integrations must also remain isolated from selected image bytes.
