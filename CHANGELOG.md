# Changelog

English is the default changelog. See [简体中文](CHANGELOG-zh.md).

## Unreleased

- Junk cleanup: deep scan adds a supplementary pass over system cache roots, broadens browser/shader cache coverage, and extends the Defender scan-history whitelist.
- Junk cleanup: deep cleanup takes ownership (safe dirs only) and expands the ownership whitelist to reduce "access denied" failures; the result view highlights only deleted count and freed space, with failures collapsed.
- Fixed deep-scan whole-category "result expired" errors and old-driver deletion failures with untranslated messages.

## v2.16.1

- Expanded junk-cleanup coverage: added a new "Third-party app cache" category (Discord, Slack, Teams, Steam, Epic Games Launcher, NetEase CloudMusic, QQ Music) and extended deep-scan cache-name matching to variants such as `Cache2`, `.cache`, and `Cache Data`, while keeping persistent app data excluded.
- Simplified the junk-cleanup result flow: after cleaning, scan categories and metrics (files found, cleanable size, selection, scan time) are cleared and only the cleanup result (space freed, files deleted, failures) is shown until the next scan. The result card uses a success theme and expands to fill most of the module space; failure details keep their warning color.
- Fixed context-menu cleanup showing an invalid-item count while hiding entries whose executable path could not be parsed.
- Expanded the custom font-size range to 10–36 px.
- Fixed the old-driver restore button showing the untranslated `restore` key.

## v2.16.0 

- Added Traditional Chinese (zh-TW) UI as a selectable language in General Settings, translated with Taiwan conventions.
- Added Windows Search index rebuild (Beta) to System Slim: detects the WSearch service state and Windows.db size, and rebuilds the index via the official SearchManager COM API when the database grows abnormally large.
- Detected the system drive via the `%SYSTEMDRIVE%`/`%SystemRoot%` environment variables (falling back to C:) for disk statistics, the health score, and the header disk display, fixing incorrect detection on machines whose system drive is not C: (e.g. dual-boot setups).

## v2.15.1 (2026-07-29)

- Improved multilingual coverage across cleanup dialogs, scan states, settings, and result pages.
- Improved social-app scanning coverage and modularized its Windows path adapters.
- Fixed OneDrive cloud-only files being counted as local large files and improved hibernation cleanup verification.
- Improved the startup screen, disk-information layout, and cleanup action controls for long results.

## v2.15.0 (2026-07-27)

### Internationalization

- Added Simplified Chinese, English, and Japanese UI support across navigation, settings, scan stages, result pages, dialogs, and operation feedback.
- Added persisted language selection with Chinese as the default and static resource loading for instant switching.
- Localized stable backend enums and scan states while keeping real paths, filenames, and system error details unchanged.

### Cleanup and Safety

- Expanded junk cleanup to Delivery Optimization files, thumbnails, DirectX shader caches, and selected rebuildable Microsoft Defender caches.
- Kept protected Defender data excluded and improved permission, ownership, and reboot-pending deletion feedback.

### User Experience

- Restored compact module headers and moved junk, large-file, and social-cache actions into compact, right-aligned fixed controls below the scan buttons without changing result scrolling.
- Improved multilingual layout handling, shared language selection, and release documentation.

## v2.14.0 (2026-07-23)

- Added third-party This PC shell icon management with registry/ACL backup, restore, safe removal, and anti-respawn protection.
- Expanded junk cleanup coverage for Windows temporary files, thumbnails, Defender rebuildable caches, and DirectX shader caches.

## v2.13.0 (2026-07-21)

- Added deep junk discovery across local fixed drives with NTFS MFT/USN scanning, controlled fallbacks, progress reporting, cancellation, paging, and backend safety rechecks.
- Added batch deletion progress, physical-size accounting, reboot-pending results, and post-delete verification.
- Expanded safe cache detection while excluding persistent application data and protected system paths.

## v2.12.2 (2026-07-17)

- Improved old-driver detection compatibility on Windows 10 and added a clearer 48px application icon.
- Improved portable-mode data migration, release markers, and separated signatures for installer, offline WebView2, and portable packages.

## v2.12.1

- Fixed Recycle Bin filtering, per-drive cleanup, Unicode filename parsing, and safe path matching.

## v2.12.0 (2026-07-13)

- Added old-driver cleanup with device-state checks, backup, restore, search, and safe deletion verification.
- Added physical disk information, AI model file deletion, and hidden-console handling for system queries.

## v2.11.3 (2026-07-08)

- Improved System Slim DISM analysis, cleanup states, timeouts, caching, and cleanup-log retention settings.
- Tightened application-cache rules to protect WebView2/Chromium persistent data and improved installer WebView2 handling.

## v2.11.2 (2026-07-07)

- Added concrete change-time display to Disk Growth Analysis.

## v2.11.1 (2026-07-06)

- Improved release signature compatibility and clarified integrity-check failures.

## v2.11.0 (2026-07-05)

- Upgraded C-drive analysis into multi-drive Disk Growth Analysis with isolated snapshots and configurable result limits.
- Added drive selection to large-file and directory analysis, plus configurable large-file result counts.
- Fixed window scaling issues and reduced cleanup animation overhead.

## v2.10.4 (2026-07-05)

- Improved AI model candidate filtering, data-directory migration safeguards, and WebView2 offline release packaging.

## v2.10.3 (2026-06-30)

- Migrated to LightC Source Available License v1.0 and clarified redistribution boundaries.

## v2.10.2 (2026-06-29)

- Added dynamic official download configuration and executable integrity verification for release packages.
- Made uninstall-leftover selection more conservative and emphasized manual verification.

## v2.10.1 (2026-06-26)

- Improved AI model type statistics, search, sorting, and bulk actions.
- Simplified uninstall-leftover guidance and risk explanations.

## v2.10.0 (2026-06-23)

- Added AI Model Storage analysis for Ollama, LM Studio, ComfyUI, HuggingFace, LoRA, Embedding, and model caches.
- Added model filters, charts, deep discovery, settings/data cleanup improvements, portable update handling, and reusable dropdown components.

## v2.9.1 (2026-06-22)

- Improved directory-analysis timestamps and made uninstall-leftover scoring and default selection more conservative.
- Added scanning-state layouts and a return-to-top action for long results.

## v2.9.0 (2026-06-21)

- Added card and page layout modes with persistent module state and page navigation.
- Improved modal behavior, social-cache transitions, risk labels, and empty states.

## v2.8.1 (2026-06-18)

- Optimized large-disk snapshots with file shards, retention limits, streaming detail comparison, and lower memory usage.

## v2.8.0 (2026-06-17)

- Added file-level Disk Growth details with drill-down navigation, pagination, virtualization, and clearer change indicators.

## v2.7.1 (2026-06-16)

- Fixed scan cancellation and diagnostics for disk, directory, and large-file analysis.
- Improved social-cache classification, System Slim timeouts, and large-file search assistance.

## v2.7.0 (2026-06-15)

- Added C-drive full analysis with MFT support, snapshots, change reports, configurable result limits, and stage diagnostics.
- Improved directory aggregation, large-file scanning, empty states, and search assistance.

## v2.6.0 (2026-06-08)

- Added the hybrid MFT large-file scanner with safe path filtering and automatic fallback for unsupported environments.

## v2.5.0 (2026-06-07)

- Added the MFT directory-analysis engine with fast administrator-mode scanning and safe fallback traversal.
- Improved Recycle Bin cleanup, uninstall-leftover accuracy, and cache classification.

## v2.4.5 (2026-06-07)

- Delivered a focused bug-fix release for cleanup and result handling.

## v2.4.4 (2026-06-04)

- Improved uninstall-leftover false-positive filtering and settings layout.

## v2.4.3 (2026-06-03)

- Added directory-analysis display settings and fixed related scan and threshold update issues.

## v2.4.2 (2026-05-16)

- Upgraded directory analysis accuracy, ranking, depth controls, performance, and Windows cache coverage.
- Fixed duplicate junk accounting, Recycle Bin cleanup, social-cache categories, large-file risk labels, and snapshot path matching.

## v2.4.1 (2026-05-03)

- Fixed critical System Slim scan blocking and improved update checks, retry behavior, and release packaging.

## v2.4.0 (2026-05-01)

- Added automatic updates, custom data directories, upgraded Context Menu Cleaner, and modular backend commands.
- Improved ProgramData snapshot safety, path validation, local incremental updates, and release assets.

## v2.3.0 (2026-04-24)

- Added ProgramData analysis, anchor navigation, global scan cancellation, and a confidence-based uninstall-leftover engine.

## v2.2.3 (2026-04-06)

- Added unlimited directory drill-down with breadcrumbs, keyboard navigation, and direct single-directory scanning.

## v2.2.2 (2026-04-05)

- Added font-size settings, system shortcuts, and an in-app changelog link.

## v2.2.1 (2026-03-29)

- Added the verified startup animation, integrity checks, and official channel notices.

## v2.2.0 (2026-03-28)

- Added Context Menu Cleaner with invalid-entry detection, system protection, risk labels, and registry backups.

## v2.1.0 (2026-03-17)

- Added Directory Analyzer, social-app cleanup expansion, deep uninstall-leftover scanning, and the feedback/community entry.

## v2.0.0 (2025-02-27)

- Initial release with junk cleanup, uninstall-leftover scanning, registry cleanup, and the enhanced deletion engine.
