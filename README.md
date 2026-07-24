# LightC

LightC is a Windows desktop utility for safe junk cleanup, disk analysis, and system maintenance. It is built with React, TypeScript, Rust, and Tauri.

[简体中文](README.zh-CN.md)

## Highlights

- Junk cleanup with quick and deep scan modes.
- Windows cleanup categories including temporary files, Delivery Optimization files, thumbnails, DirectX shader caches, and selected Microsoft Defender non-critical files.
- Large-file, disk-health, hotspot, and disk-growth analysis.
- Registry redundancy, shell/context-menu, uninstall-leftover, old-driver, and social-app cache tools.
- AI model storage analysis and portable mode.
- Safe deletion checks, detailed results, optional reboot deletion, and protected system paths.

## Screenshots

<p align="center">
  <img src="public/assets/show1.png" alt="LightC screenshot" width="900">
</p>

## Requirements

- Windows 10 or later.
- Node.js 20.19+ and npm.
- Rust toolchain and the Tauri 2 prerequisites.

## Development

```bash
npm install
npm run dev
npm run build
npm run tauri dev
```

## Portable Mode

Place `LightC.portable.json` beside the executable. LightC then stores its configuration, local data, and WebView data beside the executable instead of the default user profile location.

## Safety Notes

- LightC does not scan or delete the Windows Defender root, quarantine, definition updates, platform data, or other protected Defender data.
- Defender cleanup is limited to the rebuildable `LocalCopy` and `Support` directories.
- System32 cleanup is limited to the explicitly supported DirectX shader cache path.
- Some files require administrator permission or a system reboot and may remain listed as incomplete.
- Review selected items before permanent cleanup and keep important data backed up.

## License

See [LICENSE](LICENSE).
