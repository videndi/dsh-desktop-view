# Security policy

## Reporting

Open a private security advisory on GitHub (Security → Advisories → New
advisory) or contact the maintainer directly. Please do not open a public issue
for a vulnerability that could let a tool escape its documented behavior.

## What this plugin can do

`dsh-desktop-view` registers two read-only tools on the Harness host:

- `desktop_snapshot` captures the screen and returns the image (or its path),
  the pointer position, the monitor layout, and window titles.
- `desktop_cursor` reads the pointer position and window titles only.

Neither tool sends input to the desktop: there is no click, no key injection, no
window management, and no clipboard access. Capture runs in a short-lived
Windows PowerShell process with a fixed, generated script; the plugin passes
only numeric arguments and an output path to it.

## Data handling

- Everything happens locally. The plugin makes no network requests and has no
  telemetry.
- Captures are written to `~/.dsh/desktop-view/snapshots` and pruned to the
  newest 40 files. Deleting that directory is always safe.
- Window titles and process names from the user's desktop enter the model
  context. That is the point of the plugin, but it means a capture can contain
  secrets that happen to be on screen (passwords, chats, meeting windows).
  Operators should install it only where that is acceptable.
- Screenshots are also persisted as Harness attachments when the model route
  supports images; the attachment store is the host's own and is subject to the
  host's retention rules.

## Scope

Vulnerabilities in DeepSeek Harness itself, in Windows PowerShell, or in
`System.Drawing` are out of scope here; report those to their respective
projects.
