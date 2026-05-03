import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const SETTINGS_SHOW_FIVE_HOUR = "show-five-hour";
const SETTINGS_SHOW_WEEKLY = "show-weekly";
const SETTINGS_TOP_BAR_DISPLAY_MODE = "top-bar-display-mode";
const SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES =
  "background-refresh-interval-minutes";

const DisplayPage = GObject.registerClass(
  class DisplayPage extends Adw.PreferencesPage {
    _init(settings) {
      super._init({
        title: "Display",
        icon_name: "preferences-system-symbolic",
      });

      const topBarGroup = new Adw.PreferencesGroup({
        title: "Top Bar",
        description:
          "Choose what the top bar shows.",
      });

      const refreshGroup = new Adw.PreferencesGroup({
        title: "Refresh",
        description:
          "Control how often the extension refreshes usage data in the background.",
      });

      const topBarStyleRow = new Adw.ComboRow({
        title: "Top bar style",
        model: Gtk.StringList.new([
          "Percentages",
          "Progress bars",
          "Unified bar",
        ]),
        selected: getTopBarDisplayModeIndex(
          settings.get_string(SETTINGS_TOP_BAR_DISPLAY_MODE),
        ),
      });
      topBarGroup.add(topBarStyleRow);

      topBarStyleRow.connect("notify::selected", () => {
        settings.set_string(
          SETTINGS_TOP_BAR_DISPLAY_MODE,
          getTopBarDisplayModeValue(topBarStyleRow.selected),
        );
      });

      settings.connect(`changed::${SETTINGS_TOP_BAR_DISPLAY_MODE}`, () => {
        topBarStyleRow.selected = getTopBarDisplayModeIndex(
          settings.get_string(SETTINGS_TOP_BAR_DISPLAY_MODE),
        );
      });

      const fiveHourRow = new Adw.SwitchRow({
        title: "Show session (5h) usage",
        active: settings.get_boolean(SETTINGS_SHOW_FIVE_HOUR),
      });
      topBarGroup.add(fiveHourRow);
      settings.bind(
        SETTINGS_SHOW_FIVE_HOUR,
        fiveHourRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );

      const weeklyRow = new Adw.SwitchRow({
        title: "Show weekly usage",
        active: settings.get_boolean(SETTINGS_SHOW_WEEKLY),
      });
      topBarGroup.add(weeklyRow);
      settings.bind(
        SETTINGS_SHOW_WEEKLY,
        weeklyRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );

      const intervalAdjustment = new Gtk.Adjustment({
        lower: 0,
        upper: 60,
        step_increment: 1,
        page_increment: 5,
        value: settings.get_uint(SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES),
      });

      const refreshIntervalRow = new Adw.SpinRow({
        title: "Background refresh interval (min)",
        subtitle:
          "Set to 0 for manual refresh only.",
        adjustment: intervalAdjustment,
        climb_rate: 1,
        digits: 0,
      });
      refreshGroup.add(refreshIntervalRow);

      refreshIntervalRow.connect("notify::value", () => {
        settings.set_uint(
          SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES,
          Math.max(0, Math.round(refreshIntervalRow.value)),
        );
      });

      settings.connect(
        `changed::${SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES}`,
        () => {
          refreshIntervalRow.value = settings.get_uint(
            SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES,
          );
        },
      );

      this.add(topBarGroup);
      this.add(refreshGroup);
    }
  },
);

const AboutPage = GObject.registerClass(
  class AboutPage extends Adw.PreferencesPage {
    _init(metadata) {
      super._init({
        title: "About",
        icon_name: "help-about-symbolic",
      });

      const headerGroup = new Adw.PreferencesGroup();
      const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 18,
        margin_bottom: 12,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
      });

      const title = new Gtk.Label({
        label: `<span size="x-large"><b>${escapeMarkup(metadata.name ?? "Codex Meter")}</b></span>`,
        use_markup: true,
        justify: Gtk.Justification.CENTER,
        halign: Gtk.Align.CENTER,
        margin_bottom: 6,
      });

      const description = new Gtk.Label({
        label:
          metadata.description ??
          "Show current Codex quota usage in the GNOME top bar",
        justify: Gtk.Justification.CENTER,
        wrap: true,
        max_width_chars: 48,
        halign: Gtk.Align.CENTER,
      });

      headerBox.append(title);
      headerBox.append(description);
      headerGroup.add(headerBox);
      this.add(headerGroup);

      const infoGroup = new Adw.PreferencesGroup();

      infoGroup.add(
        this._createInfoRow(
          "Extension Version",
          metadata["version-name"] ?? `${metadata.version ?? 1}`,
        ),
      );
      infoGroup.add(
        this._createInfoRow(
          "GNOME Version",
          formatShellVersions(metadata["shell-version"]),
        ),
      );
      infoGroup.add(this._createInfoRow("UUID", metadata.uuid ?? "--"));
      infoGroup.add(
        this._createLinkRow(
          "GitHub",
          metadata.url ?? "https://github.com/slobbe/codex-meter",
        ),
      );

      this.add(infoGroup);

      const legalGroup = new Adw.PreferencesGroup();
      const legalBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 6,
        margin_bottom: 12,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        vexpand: true,
      });

      const legalLabel = new Gtk.Label({
        label:
          '<span size="small">This program comes with absolutely no warranty.\nSee the <a href="https://www.gnu.org/licenses/gpl-3.0-standalone.html">GNU General Public License, version 3 or later</a> for details.</span>',
        use_markup: true,
        justify: Gtk.Justification.CENTER,
        wrap: true,
        halign: Gtk.Align.CENTER,
      });

      legalBox.append(legalLabel);
      legalGroup.add(legalBox);
      this.add(legalGroup);
    }

    _createInfoRow(title, value) {
      const row = new Adw.ActionRow({
        title,
        activatable: false,
      });

      row.add_suffix(
        new Gtk.Label({
          label: value,
          selectable: true,
        }),
      );

      return row;
    }

    _createLinkRow(title, url) {
      const row = new Adw.ActionRow({
        title,
        activatable: false,
      });

      row.add_suffix(
        new Gtk.LinkButton({
          icon_name: "adw-external-link-symbolic",
          uri: url,
          tooltip_text: url,
          valign: Gtk.Align.CENTER,
        }),
      );

      return row;
    }
  },
);

function escapeMarkup(text) {
  return `${text}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatShellVersions(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return "--";

  return versions.join(", ");
}

function getTopBarDisplayModeIndex(value) {
  switch (value) {
    case "bars":
      return 1;
    case "unified":
      return 2;
    default:
      return 0;
  }
}

function getTopBarDisplayModeValue(selected) {
  switch (selected) {
    case 1:
      return "bars";
    case 2:
      return "unified";
    default:
      return "percentages";
  }
}

function createLegendItem(label, color) {
  const item = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    valign: Gtk.Align.CENTER,
  });

  const swatch = new Gtk.DrawingArea({
    width_request: 18,
    height_request: 10,
  });
  swatch.set_draw_func((_area, cr, width, height) => {
    cr.setSourceRGBA(...color);
    cr.rectangle(0, 0, width, height);
    cr.fill();
  });

  item.append(swatch);
  item.append(
    new Gtk.Label({
      label,
      valign: Gtk.Align.CENTER,
    }),
  );

  return item;
}

export default class CodexMeterPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    window.add(new DisplayPage(settings));
    window.add(new AboutPage(this.metadata));
    window.set_default_size(640, 720);
  }
}
