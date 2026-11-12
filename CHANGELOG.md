# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-12

### Added

- Seven input tools, so the agent can act and not only look:
  `desktop_move`, `desktop_click` (left/right/middle, 1–5 clicks),
  `desktop_drag`, `desktop_scroll`, `desktop_type` (Unicode, newline=Enter,
  tab=Tab), `desktop_key` (named keys and `+`-joined chords), and
  `desktop_window` (list, focus, minimize, maximize, restore, close).
- `scripts/control.ps1`: a `SendInput` and window-operation executor driven by a
  JSON request, with coordinate bounds checking and window resolution by title
  substring or handle.
- A kill switch: `DSH_DESKTOP_CONTROL=off` makes every input tool refuse without
  injecting anything.
- Window references now carry `hwnd`, so a specific window can be addressed even
  when two share a title.
- Shared `lib/powershell.js` process wrapper and `lib/control.js` pure helpers
  (chord parsing, action envelopes), both unit-tested.

### Changed

- Capture now goes through the same PowerShell runner as input, keeping one
  place for timeouts, cancellation and temp-file cleanup.
- Input tools validate their arguments before touching the desktop, so a bad
  call fails with a message instead of a partial action.

## [0.1.0] - 2026-11-12

### Added

- `desktop_snapshot`: capture the whole virtual desktop or one monitor, with the
  pointer ring, screen and image coordinates, monitor layout, and the titles of
  the foreground window and the window under the pointer.
- `desktop_cursor`: pointer position and window context without a capture.
- DPI-aware physical-pixel geometry across multiple monitors, including negative
  origins.
- Optional downscaling via `max_width`, with coordinates converted to the
  resulting image space.
- Image inlining through the host attachment service when the model route
  declares image input; PNG path only otherwise.
- Local retention of the newest 40 captures under
  `~/.dsh/desktop-view/snapshots`.
- English and Chinese plugin-manager metadata, unit tests, and CI.
