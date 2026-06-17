## Local Image Compress

Compress PNG and JPEG images in your desktop vault locally with bundled WebAssembly codecs. No cloud services, no external binaries, and no `node_modules` setup are required for normal plugin use.

[Русская версия](README.ru.md)

### Features
- **Local compression**: PNG through libimagequant-wasm plus PNG WASM decoding; JPEG through mozjpeg-wasm.
- **Commands**:
  - Compress all images in the current note
  - Compress all images in a folder
  - Compress all images in the entire vault
  - Move compressed files back to original locations
- **Automation**:
  - Auto-compress new files on add
  - Background compression when inactive and threshold is exceeded
- **UI & convenience**:
  - Context menu for files/folders
  - Space savings indicator with tooltip
  - Status bar progress
- **Safety & reliability**:
  - Cache of processed files with cache backups
  - Backups before moving compressed files

### Installation
1. Install `Local Image Compress` from Obsidian Community Plugins, or copy the release files to `Vault/.obsidian/plugins/local-image-compress`.
2. Enable the plugin in `Settings -> Community plugins`.
3. Start compressing images.

The release is self-contained. You do not need `pngquant`, `mozjpeg`, Homebrew, Scoop, or plugin-level `node_modules`.

### Build and release model

Source lives in `src-ts`. Root `main.js` is generated and ignored, so readable TypeScript rather than compiled output stays in Git. `npm run build` creates a production-minified local bundle; `npm run test:release` rebuilds it twice, requires deterministic bytes, validates inline WASM, and stages the release allowlist.

The GitHub release artifact contains only Obsidian install files: `manifest.json`, `main.js`, and `styles.css`. `versions.json` stays in the repository for compatibility metadata, but it is not uploaded as a release asset. Production minification is not obfuscation: the complete source remains readable in the repository. Tags are exact numeric SemVer without a `v` prefix. See [RELEASE_POLICY.md](RELEASE_POLICY.md).

### Commands
- **Compress all images in note**: Processes images referenced/used in the active note.
- **Compress all images in folder**: Lets you choose a folder and compress all supported images inside, excluding the output folder.
- **Compress all images in vault**: Full scan of the vault, excluding the output folder.
- **Move compressed files**: Moves compressed results back to original locations. Backups of originals and compressed versions are created beforehand.

### Supported formats
- PNG (`imagequant` WASM pipeline)
- JPEG/JPG (`mozjpeg` WASM pipeline)

WebP, GIF, BMP, HEIC/HEIF, and AVIF are intentionally skipped in this release because no encoder pipeline for those formats is bundled.

### Settings

| Setting | Description | Type/range | Default |
|---|---|---|---|
| PNG quality (min-max) | Quality range for lossy PNG quantization | 1-100 (e.g. `65-80`) | `65-80` |
| JPEG quality | JPEG compression quality | 1-95 | `85` |
| Allowed roots | Relative paths where compression is allowed. Empty = everywhere | list of strings | empty |
| Output folder | Where to store compressed files | string | `Compressed` |
| Auto-compress new files | Compress new images on add | boolean | `false` |
| Background compression | Compress in background when inactive | boolean | `true` |
| Background threshold | Number of uncompressed images to auto-start | 10-1000 | `50` |
| Inactivity threshold | Minutes without user input before background compression may start | 1-60 minutes | `2` |
| Cache retention | Months to keep stale cache entries after last access | 1-60 months | `12` |
| Auto-clean ghosts on start | Remove cache entries pointing to deleted files on startup | boolean | `false` |
| Auto backup retention | Delete old move backups automatically | boolean | `false` |
| Keep backups, days | Delete move backups older than N days when retention is enabled | 1-365 | `30` |
| Auto-move compressed files | Move compressed outputs back to original locations on startup when enough files are ready | boolean | `false` |
| Auto-move threshold | Number of movable compressed files required to trigger auto-move | 1-1000 | `50` |

The settings page also shows WASM module status, space savings, cache controls, ghost-entry cleanup, and backup controls.

### How it works
1. Compressed files are saved in the `Compressed` folder mirroring original paths.
2. The cache records processed files and original sizes to avoid re-compression and calculate savings correctly.
3. “Move compressed files” moves files from `Compressed` back to original locations if the original is in allowed roots. Backups are created before moving.

Minimum sizes for compression: tiny images are skipped, typically `<5KB` for PNG and `<10KB` for JPEG.

Internal safety limits are fixed: files larger than `100 MB` are skipped before reading, images above `100 million` pixels are skipped after header validation, one compression job may run for up to `120 seconds`, and worker initialization may run for up to `60 seconds`.

### Cache and backups
- **Cache**: stored at `Vault/.obsidian/plugins/local-image-compress/tinyLocal-cache.json`.
- **Cache backups**: created automatically on important changes in `Vault/.local-image-compress/backups/cache/` and capped at 50 files.
- **Backups before moving**: stored in `Vault/.local-image-compress/backups/originals/`. Includes originals and compressed files by vault-relative path.
- Existing backup folders from older versions are migrated automatically on startup. The primary cache file stays in the plugin directory.

### Automation
- “Background compression” shows a threshold slider when enabled.
- “Keep backups, days” shows a retention slider when enabled.
- “Auto-move compressed files” shows an item threshold slider. On startup, if `Compressed` count is at or above the threshold, moving starts.

### Compatibility
- `isDesktopOnly: true`.
- Requires Obsidian `1.4.0+`.
- No native compressor binaries are required on Windows, macOS, or Linux.
- Mobile support is not declared yet because cache, move, and backup file management still rely on desktop Node filesystem APIs.
- During compression and move operations, the compatible plugin `obsidian-paste-image-rename` is temporarily disabled if enabled, to avoid naming/moving conflicts. The guard restores plugins it disabled and skips restore ownership if the plugin state changed externally during the operation.

### Interaction with Paste Image Rename

This plugin temporarily disables the third-party plugin `obsidian-paste-image-rename` while compressing or moving files. There is no opt-out setting because the compressed-output mapping depends on those fresh files not being renamed by another plugin.

Why it is needed:

- Paste Image Rename registers a `vault.on("create")` handler that fires for every image added to the vault within about one second of creation. It always acts on files whose name starts with `Pasted image `, and on all other images when its "Handle all attachments" option is enabled.
- While this plugin writes compressed copies into the output folder, those fresh files trigger that handler. With an active Markdown view, Paste Image Rename renames the just-written output (which breaks this plugin's compressed-to-original mapping that the move step relies on) or shows a rename modal for each file. With no active Markdown view, it shows an `Error: No active file found` notice for every created file, which spams the interface during batch runs.
- Obsidian has no public API for one plugin to ask another to pause, so disabling that one plugin for the duration is the only reliable mitigation.

How it is kept safe:

- Only the single known plugin id `obsidian-paste-image-rename` is affected, and only while a compression or move operation is running.
- The plugin is always restored afterwards, with retries. The guard tracks whether it was the one that disabled it and skips restore ownership if the plugin's state changed externally during the operation.
- Enabling/disabling that plugin uses Obsidian's internal `app.plugins` API because there is no public equivalent; the calls are feature-detected and fail gracefully.

### Privacy and external behavior

- **Network**: the plugin makes no runtime network requests. PNG/JPEG codecs are bundled in `main.js`; images are not uploaded.
- **Telemetry and ads**: no analytics, telemetry, crash reporting, tracking, dynamic ads, or self-update mechanism is included.
- **Accounts and payments**: no account, subscription, license key, or payment is required. The manifest funding link is optional and is not contacted by the plugin.
- **Vault files**: the plugin reads supported images selected by commands, automation, or allowed roots. It writes compressed outputs to the configured vault-relative folder and can replace originals only through the documented move/auto-move flow after creating backups.
- **Local state**: cache data is stored in the plugin directory. Cache and move backups are stored under `Vault/.local-image-compress/backups/`.
- **External files**: plugin-managed data stays inside the current vault. The “Open folder” actions only ask the operating system to reveal documented backup folders; they do not transmit data.
- **Other plugins**: `obsidian-paste-image-rename` may be temporarily disabled during compression/move as disclosed above, then restored with ownership checks.

### Tips
- Reasonable quality ranges: PNG `65-80`, JPEG `75-90`.
- Configure “Allowed roots” if you want to compress only in specific folders, such as `files/` or `images/`.
- Use background compression if you have many uncompressed images; it starts on inactivity and threshold.

### FAQ
**The plugin says WebAssembly modules failed to initialize.**
Reload the plugin. If it repeats, report a bug with the Obsidian version, platform, and console error.

**Where do compressed files go?**
Into `Compressed` by default. To replace originals, use “Move compressed files”.

**How is savings calculated?**
Savings are exact when the cache has original/output sizes. For uncompressed PNG/JPEG files, the plugin uses conservative estimates with capped ratios; current compressed output sizes are read live when needed.

**What are ghost entries?**
Cache entries pointing to removed or missing files. You can clear them in settings.

### Troubleshooting
- Ensure files are large enough: very small images are skipped.
- Check “Allowed roots”: files outside these paths are not processed.
- If moving does not happen, make sure a compressed file has a corresponding original in an allowed root.
- Watch app notices and the developer console for `Local Image Compress` logs.

### Metadata
- ID: `local-image-compress`
- Name: `Local Image Compress`
- Version: `1.0.0`
- Min app version: `1.4.0`
- Desktop-only: yes
- Repository: `https://github.com/haperone/local-image-compress`

### License
- Plugin distribution: GPL-3.0-or-later (see `LICENSE`).
- The plugin bundles `imagequant`/libimagequant WebAssembly code under GPL v3, so the distributed plugin license is GPL-3.0-or-later.
- Third-party codecs: see `THIRD_PARTY_NOTICES.md` and the exact tracked texts under `licenses/`.
