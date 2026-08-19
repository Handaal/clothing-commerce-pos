# Clothing Commerce POS

Secure Electron desktop shell for the physical-store sales channel. Phase 1A-R displays
`POS Desktop — Foundation Ready` and Commerce API connectivity only.

## Boundaries and ownership

This repository owns the desktop UI, Electron lifecycle, secure preload boundary, and eventually
isolated hardware and offline operational adapters. It does not own commerce business rules,
authoritative inventory, global orders, database schema/migrations, server secrets, or privileged
database access. Future SQLite is a cache/offline operational store, never global truth. POS and
online remain channels over the same Commerce API domains.

## Technology

Electron, React, TypeScript, Vite, Vitest, ESLint, Prettier, electron-builder, and pnpm.

## Install and develop

Requirements: Node.js 24+, pnpm 10.33.1, and Git.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`COMMERCE_API_URL` is public renderer configuration and defaults to `http://localhost:3000`.
Never put a service-role, authentication, payment, webhook, or other server secret here.

## SDK and API connection

The app consumes `@shifted/clothing-commerce-sdk` 0.1.0 and sends `pos-desktop` client metadata.
During registry bootstrap, the exact pnpm-packed artifact is committed under `vendor/` and locked;
there is no sibling repository dependency. Future releases install explicit versions from an
approved private registry.

## Quality and build

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`build` compiles main/preload, bundles the renderer, and creates an unpacked Electron application.
Future releases are this repository's responsibility: Git tag → Windows build/installer → update
distribution. No deployment, installer publication, or automatic update exists now.
