# Contributing

Thanks for your interest in Pigeon. It's a small, focused project, and contributions that keep it that way are welcome.

## Setup

```bash
npm install
npm run build
npm test
npm run dev
```

Tests use vitest. Please add or update tests for any behavior change. The build must pass (`npm run build`) and the suite must be green (`npm test`) before a PR is merged.

## Scope

Pigeon does the common WhatsApp send and receive paths over a flat `/api` surface plus a clean `/v1` surface. Good contributions:

- Bug fixes and reliability improvements
- Filling gaps in existing endpoints
- New official-protocol capabilities Baileys already supports (e.g. reactions, presence), behind clean endpoints
- Docs and examples

## Out of scope

Pigeon will not accept features whose primary purpose is cold or bulk outreach: mass-send loops, contact scraping, anti-ban evasion, or anything designed to message people who did not opt in. This is a hard line, not a preference. Use the official WhatsApp Business Platform for marketing at scale.

## Style

Match the existing code. TypeScript, small focused modules, no unnecessary dependencies. Keep the core (`src/core`, `src/db`) free of HTTP concerns and the HTTP layer (`src/http`) free of protocol details.
