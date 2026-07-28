# Mobile runtime QA

Mobile runtime QA is a destructive test harness for a dedicated Android or iOS test Vault. It is excluded from the production bundle and must never be installed through the main-Vault workflow.

## Safety model

- Use a separate, local, non-synchronized QA Vault with no personal notes.
- The command is present only in the QA build.
- The command refuses to run without `.local-image-compress-qa/qa-vault-marker.json`.
- Every fixture, compressed output, cache backup, original backup, and move target is owned by `QA-LIC-Mobile-<session-id>`.
- QA settings are changed only in memory. The product cache is never cleared or replaced: QA temporarily points the cache service at hidden per-session state.
- The QA build requires persistent WebView local storage for its device-owner ID; if durable readback is unavailable, destructive QA is blocked so crash recovery cannot become orphaned.
- A versioned journal is written before isolation. On the next QA-build load, an interrupted local session is recovered before another run is allowed.
- Foreign journals are retained and ignored by their non-owning device. Corrupt or ambiguously owned journals in the local device namespace block a new destructive run.

## Build and install

From the DEV repository:

```powershell
npm run qa:mobile:build
```

The command creates the ignored `mobile-qa-build/` directory containing exactly:

- `main.js`
- `manifest.json`
- `styles.css`

It prints a deterministic `mobile-qa-src-<sha256>` build-input fingerprint plus a SHA-256 hash for every file. The fingerprint covers TypeScript sources, the QA matrix, build configuration, package/lock metadata, WASM hashes, manifest, and styles. The JSON report must contain the same fingerprint, so a report can be matched to an uncommitted QA build. Copy only those three files to `.obsidian/plugins/local-image-compress/` inside the dedicated mobile QA Vault. Do not use `main-vault:deploy` and do not copy `data.json`, cache files, reports, or session state.

After copying, compare hashes on any computer that can see the Vault:

```powershell
Get-FileHash -Algorithm SHA256 .obsidian\plugins\local-image-compress\main.js
Get-FileHash -Algorithm SHA256 .obsidian\plugins\local-image-compress\manifest.json
Get-FileHash -Algorithm SHA256 .obsidian\plugins\local-image-compress\styles.css
```

### iOS installation

Use a new local QA Vault on the iPhone or iPad and leave Sync disabled for the baseline run. The iOS Files app does not expose `.obsidian`; use a file manager that can access hidden files, such as Taio or Textastic, as described in the official [Obsidian configuration-folder guide](https://obsidian.md/help/configuration-folder).

1. Create `.obsidian/plugins/local-image-compress/` in the QA Vault if it does not exist.
2. Place only the three files from `mobile-qa-build/` in that directory.
3. Create the marker below with the same hidden-file-capable app.
4. Force-quit and reopen Obsidian.
5. In **Settings → Community plugins**, enable Local Image Compress.

Do not connect this baseline Vault to the main Vault or its Sync remote. Cross-device Sync is a separate extended interoperability pass; if it is run later, use a disposable QA-only remote Vault.

## Mark the test Vault

Create `.local-image-compress-qa/qa-vault-marker.json` manually in the QA Vault. Replace `vaultId` with a new 32-character hexadecimal value; do not reuse it for another Vault.

```json
{
  "schemaVersion": 1,
  "purpose": "local-image-compress-mobile-qa",
  "allowDestructiveQa": true,
  "vaultId": "0123456789abcdef0123456789abcdef"
}
```

The plugin never creates this marker automatically.

## Run on Android or iOS

1. Open the dedicated QA Vault.
2. Enable or reload Local Image Compress.
3. Run `Local Image Compress: Run mobile runtime qa` from the command palette.
4. Read the mutation summary and confirm.
5. Keep Obsidian in the foreground until the automated pass finishes unless you are deliberately testing lifecycle recovery.

Final files are written to:

```text
Local Image Compress QA/reports/
  runtime-qa-report-<timestamp>-<session-id>.json
  runtime-qa-log-<timestamp>-<session-id>.txt
```

Send both files when reporting a failure. The JSON is authoritative; the TXT file is a short human-readable summary. Neither report contains an absolute Vault path or names outside the QA session root.

Progress and crash-recovery state exist only while needed under:

```text
.obsidian/plugins/local-image-compress/qa-backups/mobile/<device-owner-id>/
  <session-id>.json
  runtime-qa-progress-<session-id>.json
  <session-id>.state/
```

If Obsidian is force-closed, reopen the same QA Vault with the QA build. Recovery removes only a root whose exact owner marker matches the local device/session journal. If recovery retains a journal, do not delete it blindly; send it with the report and keep the associated session root.

## Required manual device pass

The automated runner records these as `skip` with `manual-device-check`; they cannot be proven by a fake adapter or desktop DOM:

- tap and long-press behavior, on-screen keyboard, scrolling, and rotation;
- real settings controls, localized labels, action buttons, allowed-roots and folder-selector modals;
- file/folder context menus and command-palette callback dispatch;
- background/foreground during compression and cleanup;
- force-stop during `prepared`, `running`, and `restoring`, followed by reload recovery;
- Android scoped-storage access to the selected Vault;
- confirmation that no fixture, compressed output, cache, backup, or move artifact appears outside `QA-LIC-Mobile-<session-id>`; the marker, report files, and session journal/progress paths listed above are the only allowlisted exceptions.

Run the level-1 command on both Android and iOS before treating mobile-facing changes as release-verified.

The physical Android baseline was completed and verified on 2026-07-23. Do not repeat it solely to close the implementation milestone.

The following are extended stress/interoperability checks rather than prerequisites for accepting that baseline:

- behavior near mobile input/pixel limits under real OS memory pressure;
- cross-device Sync delivery reordering for cache and foreign journals.

### iOS acceptance handoff

On the dedicated iPhone/iPad QA Vault:

1. Run the automated command once in the foreground. Accept only a report with `profile: "ios"`, zero failed checks, cleanup `pass`, settings restored, and no retained artifacts.
2. Repeat while sending Obsidian to the background during compression, then return to it and verify that the run finishes or recovery completes after reopening.
3. Force-quit once during an active run, reopen the same Vault, and run again. The second run must not be blocked by the previous local journal.
4. Open the plugin settings in portrait and landscape; check scrolling, keyboard input, toggles, sliders, folder selectors, confirmation dialogs, and touch targets.
5. In a disposable manual fixture folder, rename `CaseProbe` to `caseprobe`, select it through the plugin folder picker, and verify that the renamed path is used without a duplicate or stale entry. Remove the fixture afterward.
6. Send both files from `Local Image Compress QA/reports/` and state the Obsidian/iOS versions plus whether the app was backgrounded or force-quit.

The automated M02/M06 checks verify the configured mobile memory/input/pixel limits on the real iOS runtime. Actual near-limit allocation or OS-termination stress remains an extended check and must not be inferred from those metadata-limit assertions.

## Optional Android ADB/CDP transport

The PC transport does not deploy files and does not read Android private storage. It calls the same QA-only bridge and retrieves the report by value through CDP.

Run `npm run qa:mobile:build` immediately before `qa:mobile`. A new run requires current DEV inputs and the local staged `mobile-qa-build/main.js` to match, then validates the installed report fingerprint. `qa:mobile:pull-report` deliberately does not require staging: it retrieves and saves the diagnostic report first, then compares it with the current source and any available staged bundle and returns exit code `1` on a mismatch.

```powershell
$env:ANDROID_SERIAL = "<device-serial>"
npm run qa:mobile:probe
npm run qa:mobile
npm run qa:mobile:pull-report
```

`ANDROID_SERIAL` is optional only when exactly one authorized device is connected. The environment form is used because npm 11 consumes unknown `--serial` options before script dispatch. Direct `node source-recovery/scripts/android-mobile-qa.js <command> --serial <device-serial>` invocation remains available. `--package` defaults to `md.obsidian`; `--socket` and `--target` resolve explicit ambiguity. Timeouts can be overridden with the `MOBILE_QA_*_TIMEOUT_MS` environment variables documented by `--help`.

Exit codes:

- `0`: capability probe succeeded, or QA completed successfully;
- `1`: unsafe ambiguity, QA failure, cleanup/recovery failure, or transport error;
- `2`: ADB/CDP is unavailable, so the manual command/report flow must be used.

Android WebView debugging is a capability, not a guarantee. A missing DevTools socket is an expected manual-only outcome. The transport always removes only the exact `adb forward` it created. It does not use `adb root`, repackage Obsidian, scrape global logcat, or push into app-private storage.

## Desktop parity and release gates

The existing desktop command remains independent:

```powershell
npm run qa:runtime
```

The repository test stack verifies the 27-scenario desktop/mobile matrix, session recovery, Android transport, QA mobile bundle loading, and absence of QA tokens from production/root release bundles.
