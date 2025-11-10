## Local Image Compress

Compress PNG and JPEG images in your vault with the local `pngquant` and `mozjpeg` binaries. The plugin works offline, supports batch jobs, provides optional automation, and keeps backups when moving optimized files.

[Русская версия](README.ru.md)

### Features
- **Local compression**: PNG via `pngquant`, JPEG via `mozjpeg`.
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
1. Copy the plugin folder to `Vault/.obsidian/plugins/local-image-compress`.
2. Ensure the plugin folder has `node_modules` with binaries:
   - `node_modules/pngquant-bin/vendor/pngquant(.exe)`
   - `node_modules/mozjpeg/vendor/` (mozjpeg executable)
3. Open `Settings → Community plugins` and enable `Local Image Compress`.

The plugin discovers binaries in three ways (priority order):
1) Explicit paths in settings: “Path to pngquant”, “Path to mozjpeg”
2) Auto-detection in system PATH: `pngquant`, `mozjpeg`
3) Vendor binaries inside the plugin folder: `node_modules/pngquant-bin/vendor/…`, `node_modules/mozjpeg/vendor/…`

If binaries are not found by any method, a red warning appears at the top of the settings page asking to set paths/install binaries.

### Installing binaries on Windows

Option A — npm locally (recommended, no admin rights needed)
```powershell
cd "path/to/obsidian-local-image-compress"
npm init -y
npm i pngquant-bin mozjpeg --omit=dev
# The plugin will automatically find binaries in node_modules
```

Option B — Scoop (user-scope, no admin)
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
irm get.scoop.sh | iex
scoop install git
scoop bucket add extras
scoop install pngquant
scoop install mozjpeg
# Check
pngquant --version
mozjpeg -version
```

If Scoop asks for admin — install without admin (commands above). If it requires git — `scoop install git` or `winget install Git.Git`.

Option C — manual
- Download `pngquant` and `mozjpeg` executables and set their paths in plugin settings: “Path to pngquant”, “Path to mozjpeg”.
- Or place them in `node_modules/pngquant-bin/vendor/` and `node_modules/mozjpeg/vendor/`.

### Installing binaries on macOS

Option A — Homebrew (recommended)
```bash
brew update
brew install pngquant mozjpeg
# Check
pngquant --version
mozjpeg -version
```

Option B — npm locally (in the plugin/repo folder)
```bash
cd path/to/obsidian-local-image-compress
npm init -y
npm i pngquant-bin mozjpeg --omit=dev
# The plugin will automatically find binaries in node_modules
```

Option C — manual
- Download `pngquant` and `mozjpeg` executables for macOS and set their paths in plugin settings.
- Or place them in `node_modules/pngquant-bin/vendor/` and `node_modules/mozjpeg/vendor/`.

### Commands
- **Compress all images in note**: Processes images referenced/used in the active note.
- **Compress all images in folder**: Lets you choose a folder and compress all supported images inside (excluding the output folder).
- **Compress all images in vault**: Full scan of the vault, excluding the output folder.
- **Move compressed files (to original locations)**: Moves compressed results back to where originals were. Backups of originals and compressed versions are created beforehand.

### Supported formats
- PNG (`pngquant`)
- JPEG/JPG (`mozjpeg`)

### Settings

| Setting | Description | Type/range | Default |
|---|---|---|---|
| PNG quality (min-max) | Quality range for `pngquant` | 0–100 (e.g. `65-80`) | `65-80` |
| JPEG quality | Quality for `mozjpeg` | 1–95 | `85` |
| Allowed roots | Relative paths where compression is allowed. Empty = everywhere | list of strings | empty |
| Output folder | Where to store compressed files | string | `Compressed` |
| Auto-compress new files | Compress new images on add | boolean | `false` |
| Background compression | Compress in background when inactive | boolean | `true` |
| Background threshold | Number of uncompressed images to auto-start | 10–1000 | `50` |
| Path to pngquant | Full path or empty for auto-detection | string | empty |
| Path to mozjpeg | Full path or empty for auto-detection | string | empty |
| Auto-clean ghosts on start | Remove cache entries pointing to deleted files on startup | boolean | `false` |
| Keep backups, days | Delete backups older than N days (0 = keep) | 0–365 | `30` |

Additionally, the settings page shows a space savings indicator and controls for cache, ghost entries, and backups.

### How it works
1. Compressed files are saved in the `Compressed` folder mirroring original paths.
2. The cache records processed files and original sizes to avoid re-compression and calculate savings correctly.
3. “Move compressed files” moves files from `Compressed` back to original locations (if the original is in allowed roots). Backups are created before moving.

Minimum sizes for compression: tiny images are skipped (typically `<5KB` for PNG and `<10KB` for JPEG).

### Cache and backups
- **Cache**: stored at `Vault/.obsidian/plugins/local-image-compress/tinyLocal-cache.json`. Available actions:
  - Clear cache
  - Refresh cache
  - Restore cache from backup (list of backups is available in settings)
- **Cache backups**: created automatically on important changes in `cache-backups/`.
- **Backups before moving**: stored in `original-files-backups/` inside the plugin directory. Includes originals (by vault-relative paths) and compressed files.
  - The settings page includes a button “Open image backups folder”.
  - Old backups are cleaned automatically on startup per “Keep backups, days”.

### Automation (dynamic settings)
- “Background compression” — when enabled, a “Threshold” slider appears.
- “Keep backups, days — enable” — when enabled, a slider for days appears.
- “Auto-move compressed — enable” — when enabled, a slider “Auto-move threshold (items)” appears. On startup, if `Compressed` count ≥ threshold, moving starts.

### Status bar and savings
- The status bar shows the state (compression in progress, etc.).
- The settings page shows a “space savings” block with a tooltip: original size, current size, savings (%) and processed file stats.

### Limitations and compatibility
- Desktop only (`isDesktopOnly: true`).
- Requires app version `1.0.0+`.
- Requires `pngquant` and `mozjpeg` binaries for your platform (Windows/macOS/Linux).
- During operations, the compatible plugin `obsidian-paste-image-rename` may be temporarily disabled (if enabled) to avoid naming/moving conflicts.

### Tips
- Reasonable quality ranges: PNG `65-80`, JPEG `75-90` — good balance between size and quality.
- Configure “Allowed roots” if you want to compress only in specific folders (e.g. `files/`, `images/`).
- Use background compression if you have many uncompressed images; it will start on inactivity and threshold.

### FAQ
**The plugin says binaries are not found.**
— Check `node_modules/pngquant-bin/vendor/` and `node_modules/mozjpeg/vendor/`. Ensure execution rights (macOS/Linux) or valid `.exe` (Windows).

**Where do compressed files go?**
— Into `Compressed` (configurable). To replace originals, use “Move compressed files to Files” — it will move corresponding compressed files to the originals’ locations and create backups.

**How is savings calculated?**
— The settings page displays an indicator and tooltip. Original sizes are stored in cache; current sizes are read live.

**What are “ghost entries”?**
— Cache entries pointing to removed or missing files. You can clear them with a button in settings.

### Troubleshooting
- Ensure files are large enough: very small images are skipped.
- Check “Allowed roots”: files outside these paths will not be processed.
- If moving doesn’t happen — make sure a compressed file has a corresponding original in an allowed root.
- Watch app notices and the developer console (Ctrl+Shift+I) for `Local Image Compress` logs.

### Metadata
- ID: `local-image-compress`
- Name: `Local Image Compress`
- Version: `1.0.0`
- Min app version: `1.0.0`
- Desktop-only: yes

### License
- Plugin code: MIT (see `LICENSE`).
- Third-party: `pngquant` — GPL-3.0; `mozjpeg` — BSD-3-Clause/IJG. See `THIRD_PARTY_NOTICES.md` for details.


