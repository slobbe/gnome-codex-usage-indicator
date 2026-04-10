# Codex Usage Indicator GNOME Extension

Monitor your Codex usage directly from the GNOME top bar.

[![GitHub Release](https://img.shields.io/github/v/release/slobbe/gnome-codex-usage-indicator?style=flat-square&color=royalblue)](https://github.com/slobbe/gnome-codex-usage-indicator/releases/latest)
[![GitHub License](https://img.shields.io/github/license/slobbe/gnome-codex-usage-indicator?style=flat-square&color=teal)](/LICENSE)

> Inspired by [CodexBar](https://github.com/steipete/CodexBar) by [Peter Steinberger](https://github.com/steipete), adapted for GNOME.

## Features

- Displays current 5-hour and weekly Codex usage
- Shows 5-hour usage, weekly usage, or both in the top bar
- Choose between raw percentages, progress bars, or unified _combined-pressure_ bar
- Supports manual refresh and configurable background refresh intervals

## Install

> [!NOTE]
> Requires the Codex CLI and an active login on the same machine.
> The extension reads your local local auth credentials from `~/.codex/auth.json` to fetch usage data from `https://chatgpt.com/backend-api/wham/usage`.

1. Download the [latest release](https://github.com/slobbe/gnome-codex-usage-indicator/releases/latest) zip.
2. Install and enable the extension with:

```sh
gnome-extensions install codex-usage@slobbe.github.io-<version>.zip --force
gnome-extensions enable codex-usage@slobbe.github.io
```

If GNOME does not pick it up immediately, log out and back in.

## Development / Build

For local development, install the extension into your user extensions directory:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/codex-usage@slobbe.github.io
rsync -a --delete ./ ~/.local/share/gnome-shell/extensions/codex-usage@slobbe.github.io/
glib-compile-schemas schemas
gnome-extensions disable codex-usage@slobbe.github.io
gnome-extensions enable codex-usage@slobbe.github.io
```

To build a release bundle locally:

```bash
./build-release.sh
```

This writes the packaged extension zip to `dist/`.

## License

[GPL-3.0-or-later](/LICENSE)
