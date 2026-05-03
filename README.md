# Codex Meter GNOME Extension

Monitor your Codex usage directly from the GNOME top panel.

[![GitHub Release](https://img.shields.io/github/v/release/slobbe/codex-meter?style=flat-square&color=royalblue)](https://github.com/slobbe/codex-meter/releases/latest)
[![GitHub License](https://img.shields.io/github/license/slobbe/codex-meter?style=flat-square&color=teal)](/LICENSE)

> Inspired by [CodexBar](https://github.com/steipete/CodexBar) by [Peter Steinberger](https://github.com/steipete), adapted for GNOME.

## Features

- Displays current 5-hour and weekly Codex usage
- Predicts whether current usage trends will hit the session or weekly limit before reset
- Shows 5-hour usage, weekly usage, or both in the top bar
- Choose between raw percentages, progress bars, or unified _combined-pressure_ bar
- Supports manual refresh and configurable background refresh intervals
- Shows a 14-day usage chart in preferences and records successful checks to a local CSV history file

## Install

> [!NOTE]
> Requires the Codex CLI and an active login on the same machine.
> The extension reads your local local auth credentials from `~/.codex/auth.json` to fetch usage data from `https://chatgpt.com/backend-api/wham/usage`.
> Successful checks are recorded in `${XDG_CACHE_HOME:-~/.cache}/codex-meter/usage-history.csv` with `timestamp`, `session_used_percent`, and `weekly_used_percent` columns. The extension keeps 90 days of history.

1. Download the [latest release](https://github.com/slobbe/codex-meter/releases/latest) zip.
2. Install and enable the extension with:

```sh
gnome-extensions install codex-meter@slobbe.github.io-<version>.zip --force
gnome-extensions enable codex-meter@slobbe.github.io
```

If GNOME does not pick it up immediately, log out and back in.

## Development / Build

For local development, install the extension into your user extensions directory:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/codex-meter@slobbe.github.io
rsync -a --delete ./ ~/.local/share/gnome-shell/extensions/codex-meter@slobbe.github.io/
glib-compile-schemas schemas
gnome-extensions disable codex-meter@slobbe.github.io
gnome-extensions enable codex-meter@slobbe.github.io
```

To build a release bundle locally:

```bash
./build-release.sh
```

This writes the packaged extension zip to `dist/`.

## License

[GPL-3.0-or-later](/LICENSE)
