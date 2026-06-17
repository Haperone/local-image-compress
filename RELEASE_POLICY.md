# Release policy

This repository keeps readable TypeScript source in Git and generates the
installed production bundle locally or in CI.

## Source and generated output

- TypeScript source lives in `src-ts`.
- Root `main.js` is generated, ignored, and must not be tracked.
- `npm run build` creates a production-minified root `main.js` for local
  Obsidian development.
- `dist-ts/main.js` is also generated and ignored.
- The generated banner points reviewers to the readable repository source;
  minification is used for production size, not obfuscation.

## Verification

`npm run test:release`:

1. Runs lint, scanner, smoke, typecheck, manifest, license, and inline WASM
   checks against readable source and a review bundle.
2. Builds the production-minified worker and root bundle.
3. Rebuilds production output and requires byte-identical SHA-256 results.
4. Runs `verify:root-ts` to prove root `main.js` equals the generated
   production artifact.
5. Recreates `build/` from the explicit Obsidian install-file allowlist.

The production build has no source map and keeps WASM codecs inline, so users
do not need package dependencies, external binaries, or separate `.wasm`
files.

## Release contract

Future releases use an exact numeric SemVer tag equal to `manifest.json`, for
example `1.0.0`. A `v` prefix is rejected. Historical remote tags are not
rewritten.

GitHub release assets are exactly:

- `manifest.json`
- `main.js`
- `styles.css`

`versions.json` remains tracked in the repository for compatibility metadata,
but it is not a GitHub Release asset.

The ignored `build/` staging directory is recreated on every release. It must
not contain source workspaces, package metadata, caches, settings, backups,
QA output, or dependencies.

## Version ownership

The current version must agree across `manifest.json`, `versions.json`, root
`package.json`, README metadata, and the release tag. `minAppVersion` remains
`1.4.0` while current API types are used only as a compile-time review
surface.
