import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SETTINGS_SHOW_FIVE_HOUR = 'show-five-hour';
const SETTINGS_SHOW_WEEKLY = 'show-weekly';

const DisplayPage = GObject.registerClass(
class DisplayPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Display',
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Top Bar',
            description: 'Choose which Codex usage percentages are shown in the GNOME top bar.',
        });

        const fiveHourRow = new Adw.SwitchRow({
            title: 'Show 5-hour usage',
            subtitle: 'Displays the current 5-hour window percentage.',
            active: settings.get_boolean(SETTINGS_SHOW_FIVE_HOUR),
        });
        group.add(fiveHourRow);
        settings.bind(
            SETTINGS_SHOW_FIVE_HOUR,
            fiveHourRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        const weeklyRow = new Adw.SwitchRow({
            title: 'Show weekly usage',
            subtitle: 'Displays the current weekly window percentage.',
            active: settings.get_boolean(SETTINGS_SHOW_WEEKLY),
        });
        group.add(weeklyRow);
        settings.bind(
            SETTINGS_SHOW_WEEKLY,
            weeklyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        this.add(group);
    }
});

const AboutPage = GObject.registerClass(
class AboutPage extends Adw.PreferencesPage {
    _init(metadata) {
        super._init({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        const headerGroup = new Adw.PreferencesGroup();
        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 18,
            margin_bottom: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });

        const icon = new Gtk.Image({
            icon_name: 'utilities-system-monitor-symbolic',
            pixel_size: 84,
            margin_bottom: 16,
        });

        const title = new Gtk.Label({
            label: `<span size="x-large"><b>${escapeMarkup(metadata.name ?? 'Codex Usage Indicator')}</b></span>`,
            use_markup: true,
            justify: Gtk.Justification.CENTER,
            halign: Gtk.Align.CENTER,
            margin_bottom: 6,
        });

        const description = new Gtk.Label({
            label: metadata.description ?? 'Show current Codex quota usage in the GNOME top bar',
            justify: Gtk.Justification.CENTER,
            wrap: true,
            max_width_chars: 48,
            halign: Gtk.Align.CENTER,
        });

        headerBox.append(icon);
        headerBox.append(title);
        headerBox.append(description);
        headerGroup.add(headerBox);
        this.add(headerGroup);

        const infoGroup = new Adw.PreferencesGroup();

        infoGroup.add(this._createInfoRow(
            'Extension Version',
            metadata['version-name'] ?? `${metadata.version ?? 1}`
        ));
        infoGroup.add(this._createInfoRow(
            'GNOME Version',
            formatShellVersions(metadata['shell-version'])
        ));
        infoGroup.add(this._createInfoRow(
            'UUID',
            metadata.uuid ?? '--'
        ));

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
            label: '<span size="small">This program comes with absolutely no warranty.\nSee the <a href="https://gnu.org/licenses/old-licenses/gpl-2.0.html">GNU General Public License, version 2 or later</a> for details.</span>',
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

        row.add_suffix(new Gtk.Label({
            label: value,
            selectable: true,
        }));

        return row;
    }
});

function escapeMarkup(text) {
    return `${text}`
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatShellVersions(versions) {
    if (!Array.isArray(versions) || versions.length === 0)
        return '--';

    return versions.join(', ');
}

export default class AIUsageIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(new DisplayPage(settings));
        window.add(new AboutPage(this.metadata));
        window.set_default_size(640, 720);
    }
}
