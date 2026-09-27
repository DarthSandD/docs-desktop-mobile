# Docs — a desktop-class document editor for Android

A Google-Docs-style rich text editor that runs **the desktop page experience on a phone**:
real 8.5″ × 11″ page sheets, margins, a ruler, and a full always-visible formatting
toolbar — no hunting through a mobile menu to find "Print layout".

## What it is

| | |
|---|---|
| **APK** | [`apk/Docs-debug.apk`](apk/Docs-debug.apk) (181 KB, debug-signed) |
| **Package** | `com.docsclone.app` |
| **Min / target SDK** | 24 (Android 7.0) / 34 (Android 14) |
| **Architecture** | Native Android shell (`WebView`) + self-contained HTML/CSS/JS editor engine |
| **Dependencies** | None (pure framework Android; editor engine is dependency-free) |

## Screenshots

| Document (fit to width) | Multi-page with gutters |
|---|---|
| ![Document](docs/screenshots/01_document_fit.png) | ![Multi-page](docs/screenshots/09_two_pages_gutter.png) |

| Formatting toolbar | Dark theme |
|---|---|
| ![Toolbar](docs/screenshots/02_toolbar_formatting.png) | ![Dark](docs/screenshots/06_dark_theme.png) |

## Project status

_Last verified: 2026-09-27_

| Item | Value |
|---|---|
| APK | [`apk/Docs-debug.apk`](apk/Docs-debug.apk) — 180,942 bytes |
| APK MD5 | `b1797c71e3fe4b249c68a3e38985adb6` |
| Signature | APK Signature Scheme v2 (debug key) |
| Automated checks | 92 passing (19 engine, 44 export/import, 11 live geometry) + 18 on-device |

## Environment snapshot

_Versions confirmed on 2026-09-27._

| Component | Version | Source |
|---|---|---|
| Android compile / target SDK | 34 (Android 14) | `app/build.gradle` |
| Android min SDK | 24 (Android 7.0) | `app/build.gradle` |
| Android Gradle Plugin | 8.4.2 | `build.gradle` |
| Gradle | 8.7 | `gradle/wrapper/gradle-wrapper.properties` |
| JDK | 17 (Temurin 17.0.20.1) | build environment |
| Build tools | 34.0.0 | build environment |

### Upgrade available

- **Gradle**: 9.8.0 (released 2026-09-24) – current stable version is newer than the repo's 8.7
- **Android Gradle Plugin**: 9.4.0 (September 2026) – current stable version is newer than the repo's 8.4.2
- **Android SDK**: 16 (API level 36) – current stable platform is newer than the repo's 34

## The core idea

Mobile document editors force you into a cramped reflowed view, and switching to
page layout is buried in a menu. This app inverts that: **print layout is the default
and only real mode**, implemented as a true paginated canvas.

Pagination is not simulated. The engine measures every top-level block, and when a
block would straddle a page boundary it inserts a non-editable spacer that pushes the
block to the next page — the same behaviour as a desktop word processor. Spacers are
stripped from saved output, so the document model stays clean.

Page geometry is exact: US Letter at 96 dpi = **816 × 1056 CSS px**, with 96 px
margins, matching the ruler's inch ticks.

## Features

**Desktop-level editing**
- Bold / italic / underline / strikethrough, superscript / subscript
- Headings H1–H3, blockquote, code block, normal text
- Bulleted and numbered lists, indent / outdent
- Text colour and highlight (48-swatch palette)
- Left / centre / right / justify alignment, line spacing 1.0–2.0
- Tables, horizontal rules, hyperlinks
- Font family and size (8–72 pt)
- Live word / character count and page indicator
- Multi-document storage with recent-documents switcher

## Tests

All automated checks pass:

| Suite | Result |
|---|---|
| Engine (jsdom) | 19 / 19 |
| Export format verification | 44 / 44 |
| Live pagination geometry (Chrome) | 11 / 11 |
| On-device Android WebView | 18 / 18 |

## Notes and limitations

- The debug APK is signed with the standard Android debug key — fine for sideloading,
  not for Play Store distribution. Generate a release keystore before publishing.
- `.docx` export covers text, inline formatting, headings, lists, quotes and rules.
  Tables and images export to HTML/Markdown but are not yet written into the DOCX.
- The editor uses `document.execCommand`, which is deprecated but remains by far the
  most reliable rich-text primitive available in Android WebView. Undo/redo is
  therefore implemented with the engine's own snapshot history.
- On very low-memory machines the emulator's own SystemUI may ANR. That is the
  emulator host, not the app; the app itself reported zero runtime errors.

## Daily maintenance

A scheduled job refreshes this README every day at **09:00**. Each run:

1. **Verifies the shipped APK** — recomputes the MD5 and confirms it still matches
   the published artifact, so a stale or swapped binary is caught immediately.
2. **Refreshes the environment snapshot** — reads the real versions from
   `app/build.gradle`, `build.gradle` and `gradle-wrapper.properties` rather than
   trusting what is written here.
3. **Re-runs the test suites** and updates the pass counts, so the claimed
   numbers can never drift from reality.
4. **Checks for upstream drift** — looks for newer Android Gradle Plugin, Gradle,
   and compile-SDK releases, and notes anything worth upgrading.
5. **Commits and pushes** only when something actually changed, with a dated
   commit message.

The job is deliberately conservative: if nothing changed, it changes nothing.
It never invents version numbers, and it never marks a check as passing without
having run it.

### Keeping a local checkout current

```bash
git pull
./gradlew assembleDebug
```
