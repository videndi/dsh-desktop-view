# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-02

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
