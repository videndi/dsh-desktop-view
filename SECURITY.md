# Security policy

## Reporting

Open a private security advisory on GitHub (Security → Advisories → New
advisory) or contact the maintainer directly. Please do not open a public issue
for a vulnerability that could let a tool escape its documented behavior.

## What this plugin can do

`dsh-desktop-view` registers nine tools on the Harness host.

Read-only:

- `desktop_snapshot` captures the screen and returns the image (or its path),
  the pointer position, the monitor layout, and window titles.
- `desktop_cursor` reads the pointer position and window titles only.

Input:

- `desktop_move`, `desktop_click`, `desktop_drag`, `desktop_scroll`,
  `desktop_type`, `desktop_key` send mouse and keyboard input to whatever is
  focused, and `desktop_window` focuses, minimizes, maximizes, restores, or
  closes a visible window.

There is no clipboard access, no file management, no process control beyond
closing a window, and no network access. Input runs through a short-lived
Windows PowerShell process with a fixed, generated script; the plugin passes it
only numbers, key codes, text, and window identifiers.

## Kill switch

Setting `DSH_DESKTOP_CONTROL=off` in the environment that launches Harness makes
every input tool refuse before it sends anything. Observation tools keep working.

## Data handling

- Everything happens locally. The plugin makes no network requests and has no
  telemetry.
- Captures are written to `~/.dsh/desktop-view/snapshots` and pruned to the
  newest 40 files. Deleting that directory is always safe.
- Window titles, process names and typed text enter the model context. That is
  the point of the plugin, but it means a capture can contain secrets that happen
  to be on screen (passwords, chats, meeting windows), and typed text reaches
  whichever control has focus.
- Screenshots are also persisted as Harness attachments when the model route
  supports images; the attachment store is the host's own and is subject to the
  host's retention rules.

## Operator responsibility

The input tools act immediately and cannot be undone. An operator who grants the
agent this capability should assume it can press any visible button, including
destructive ones, unless the environment narrows its tool surface.

## Scope

Vulnerabilities in DeepSeek Harness itself, in Windows PowerShell, or in
`System.Drawing` and `user32` are out of scope here; report those to their
respective projects.
