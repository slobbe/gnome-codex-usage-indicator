# Codex Usage Indicator GNOME Extension

> Monitor your Codex usage directly from the GNOME top bar.

Inspired by [CodexBar](https://github.com/steipete/CodexBar) by [Peter Steinberger](https://github.com/steipete), adapted for GNOME.

## Install

> [!NOTE]
> Requires the Codex CLI and an active login on the same machine.
> The extension reads your local local auth credentials from `~/.codex/auth.json` to fetch usage data.

1. Download the [latest release](https://github.com/slobbe/gnome-codex-usage-indicator/releases/latest) zip.
2. Install it with:

```bash
gnome-extensions install codex-usage@slobbe.github.io-<version>.zip --force
```

3. Enable the extension:

```bash
gnome-extensions enable codex-usage@slobbe.github.io
```

4. Open preferences if needed:

```bash
gnome-extensions prefs codex-usage@slobbe.github.io
```

If GNOME does not pick it up immediately, log out and back in.

## Developer / Build

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
