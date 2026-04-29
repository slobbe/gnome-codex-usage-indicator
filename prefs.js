import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {readUsageHistory} from './codex.js';

const SETTINGS_SHOW_FIVE_HOUR = 'show-five-hour';
const SETTINGS_SHOW_WEEKLY = 'show-weekly';
const SETTINGS_TOP_BAR_DISPLAY_MODE = 'top-bar-display-mode';
const SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES = 'background-refresh-interval-minutes';
const HISTORY_SESSION_COLOR = [0.29, 0.76, 0.43, 1];
const HISTORY_WEEK_COLOR = [0.22, 0.55, 0.90, 1];
const HISTORY_GRID_COLOR = [0.5, 0.5, 0.5, 0.25];
const HISTORY_LABEL_COLOR = [0.5, 0.5, 0.5, 0.8];
const HISTORY_CHART_DAYS = 30;
const HISTORY_CSV_PATH = GLib.build_filenamev([
    GLib.get_user_cache_dir(),
    'codex-usage-indicator',
    'usage-history.csv',
]);

const DisplayPage = GObject.registerClass(
class DisplayPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Display',
            icon_name: 'preferences-system-symbolic',
        });

        const topBarGroup = new Adw.PreferencesGroup({
            title: 'Top Bar',
            description: 'Choose what the GNOME top bar shows and which usage windows are included.',
        });

        const refreshGroup = new Adw.PreferencesGroup({
            title: 'Refresh',
            description: 'Control how often the extension refreshes usage data in the background.',
        });

        const topBarStyleRow = new Adw.ComboRow({
            title: 'Top bar style',
            subtitle: 'Choose whether the GNOME top bar shows percentages, split progress bars, or a unified bar that combines Session and Week usage.',
            model: Gtk.StringList.new(['Percentages', 'Progress bars', 'Unified bar']),
            selected: getTopBarDisplayModeIndex(settings.get_string(SETTINGS_TOP_BAR_DISPLAY_MODE)),
        });
        topBarGroup.add(topBarStyleRow);

        topBarStyleRow.connect('notify::selected', () => {
            settings.set_string(
                SETTINGS_TOP_BAR_DISPLAY_MODE,
                getTopBarDisplayModeValue(topBarStyleRow.selected)
            );
        });

        settings.connect(`changed::${SETTINGS_TOP_BAR_DISPLAY_MODE}`, () => {
            topBarStyleRow.selected =
                getTopBarDisplayModeIndex(settings.get_string(SETTINGS_TOP_BAR_DISPLAY_MODE));
        });

        const fiveHourRow = new Adw.SwitchRow({
            title: 'Show 5-hour usage',
            subtitle: 'Displays the current 5-hour window percentage.',
            active: settings.get_boolean(SETTINGS_SHOW_FIVE_HOUR),
        });
        topBarGroup.add(fiveHourRow);
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
        topBarGroup.add(weeklyRow);
        settings.bind(
            SETTINGS_SHOW_WEEKLY,
            weeklyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        const intervalAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 60,
            step_increment: 1,
            page_increment: 5,
            value: settings.get_uint(SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES),
        });

        const refreshIntervalRow = new Adw.SpinRow({
            title: 'Background refresh interval',
            subtitle: 'How often usage data refreshes in the background, in minutes. Set to 0 for manual refresh only.',
            adjustment: intervalAdjustment,
            climb_rate: 1,
            digits: 0,
        });
        refreshGroup.add(refreshIntervalRow);

        refreshIntervalRow.connect('notify::value', () => {
            settings.set_uint(
                SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES,
                Math.max(0, Math.round(refreshIntervalRow.value))
            );
        });

        settings.connect(`changed::${SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES}`, () => {
            refreshIntervalRow.value = settings.get_uint(SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES);
        });

        this.add(topBarGroup);
        this.add(refreshGroup);
    }
});

const HistoryPage = GObject.registerClass(
class HistoryPage extends Adw.PreferencesPage {
    _init() {
        super._init({
            title: 'History',
            icon_name: 'view-statistics-symbolic',
        });

        this._historyRows = readUsageHistory({hours: HISTORY_CHART_DAYS * 24});

        const historyGroup = new Adw.PreferencesGroup({
            title: 'Usage History',
            description: `Session and weekly usage percentages from the past ${HISTORY_CHART_DAYS} days.`,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        this._statusLabel = new Gtk.Label({
            label: this._getStatusText(),
            halign: Gtk.Align.START,
            visible: this._getDrawableRows().length < 2,
        });

        this._drawingArea = new Gtk.DrawingArea({
            height_request: 220,
            hexpand: true,
            vexpand: false,
            visible: this._getDrawableRows().length >= 2,
        });
        this._drawingArea.set_draw_func((_area, cr, width, height) => {
            drawHistoryChart(cr, width, height, this._historyRows);
        });

        const legend = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 16,
            halign: Gtk.Align.START,
        });
        legend.append(createLegendItem('Session', HISTORY_SESSION_COLOR));
        legend.append(createLegendItem('Week', HISTORY_WEEK_COLOR));

        const historyPathLabel = new Gtk.Label({
            label: `Full 90-day CSV history: ${HISTORY_CSV_PATH}`,
            halign: Gtk.Align.START,
            selectable: true,
            wrap: true,
            xalign: 0,
        });
        historyPathLabel.add_css_class('dim-label');

        box.append(this._statusLabel);
        box.append(this._drawingArea);
        box.append(legend);
        box.append(historyPathLabel);
        historyGroup.add(box);
        this.add(historyGroup);
    }

    _getDrawableRows() {
        return this._historyRows.filter(row =>
            Number.isFinite(new Date(row.timestamp).getTime()) &&
            (Number.isFinite(row.sessionUsedPercent) || Number.isFinite(row.weeklyUsedPercent))
        );
    }

    _getStatusText() {
        if (this._historyRows.length === 0)
            return 'No usage history yet';

        if (this._getDrawableRows().length < 2)
            return 'Need at least two samples to draw history';

        return '';
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
        infoGroup.add(this._createLinkRow(
            'GitHub',
            metadata.url ?? 'https://github.com/slobbe/gnome-codex-usage-indicator'
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
            label: '<span size="small">This program comes with absolutely no warranty.\nSee the <a href="https://www.gnu.org/licenses/gpl-3.0-standalone.html">GNU General Public License, version 3 or later</a> for details.</span>',
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

    _createLinkRow(title, url) {
        const row = new Adw.ActionRow({
            title,
            activatable: false,
        });

        row.add_suffix(new Gtk.LinkButton({
            icon_name: 'adw-external-link-symbolic',
            uri: url,
            tooltip_text: url,
            valign: Gtk.Align.CENTER,
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

function getTopBarDisplayModeIndex(value) {
    switch (value) {
    case 'bars':
        return 1;
    case 'unified':
        return 2;
    default:
        return 0;
    }
}

function getTopBarDisplayModeValue(selected) {
    switch (selected) {
    case 1:
        return 'bars';
    case 2:
        return 'unified';
    default:
        return 'percentages';
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
    item.append(new Gtk.Label({
        label,
        valign: Gtk.Align.CENTER,
    }));

    return item;
}

function drawHistoryChart(cr, width, height, rows) {
    const padding = {
        top: 12,
        right: 12,
        bottom: 34,
        left: 34,
    };
    const drawableRows = rows
        .map(row => ({
            time: new Date(row.timestamp).getTime(),
            sessionUsedPercent: row.sessionUsedPercent,
            weeklyUsedPercent: row.weeklyUsedPercent,
        }))
        .filter(row =>
            Number.isFinite(row.time) &&
            (Number.isFinite(row.sessionUsedPercent) || Number.isFinite(row.weeklyUsedPercent))
        )
        .sort((left, right) => left.time - right.time);

    if (drawableRows.length < 2)
        return;

    const minTime = drawableRows[0].time;
    const maxTime = drawableRows[drawableRows.length - 1].time;
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const timeSpan = Math.max(1, maxTime - minTime);

    cr.setLineWidth(1);
    cr.setSourceRGBA(...HISTORY_GRID_COLOR);

    for (const percent of [0, 50, 100]) {
        const y = padding.top + chartHeight - ((percent / 100) * chartHeight);
        cr.moveTo(padding.left, y);
        cr.lineTo(width - padding.right, y);
        cr.stroke();
        drawYAxisLabel(cr, `${percent}%`, padding.left - 6, y);
    }

    drawXAxisLabels(cr, minTime, maxTime, padding, chartWidth, chartHeight);

    drawHistorySeries(
        cr,
        drawableRows,
        'sessionUsedPercent',
        HISTORY_SESSION_COLOR,
        padding,
        chartWidth,
        chartHeight,
        minTime,
        timeSpan
    );
    drawHistorySeries(
        cr,
        drawableRows,
        'weeklyUsedPercent',
        HISTORY_WEEK_COLOR,
        padding,
        chartWidth,
        chartHeight,
        minTime,
        timeSpan
    );
}

function drawXAxisLabels(cr, minTime, maxTime, padding, chartWidth, chartHeight) {
    const points = [
        {time: minTime, x: padding.left, align: 'start'},
        {time: minTime + ((maxTime - minTime) / 2), x: padding.left + (chartWidth / 2), align: 'center'},
        {time: maxTime, x: padding.left + chartWidth, align: 'end'},
    ];
    const y = padding.top + chartHeight + 18;

    for (const point of points)
        drawXAxisLabel(cr, formatAxisDate(point.time), point.x, y, point.align);
}

function drawXAxisLabel(cr, label, x, y, align) {
    cr.save();
    cr.selectFontFace('Sans', 0, 0);
    cr.setFontSize(10);

    const extents = cr.textExtents(label);
    let labelX = x;

    if (align === 'center')
        labelX -= extents.width / 2;
    else if (align === 'end')
        labelX -= extents.width;

    cr.setSourceRGBA(...HISTORY_LABEL_COLOR);
    cr.moveTo(labelX, y);
    cr.showText(label);
    cr.restore();
}

function formatAxisDate(value) {
    try {
        return new Intl.DateTimeFormat(undefined, {
            month: 'short',
            day: 'numeric',
        }).format(new Date(value));
    } catch (_error) {
        return '--';
    }
}

function drawYAxisLabel(cr, label, rightX, centerY) {
    cr.save();
    cr.selectFontFace('Sans', 0, 0);
    cr.setFontSize(10);

    const extents = cr.textExtents(label);
    cr.setSourceRGBA(...HISTORY_LABEL_COLOR);
    cr.moveTo(rightX - extents.width, centerY + (extents.height / 2));
    cr.showText(label);
    cr.restore();
}

function drawHistorySeries(cr, rows, key, color, padding, chartWidth, chartHeight, minTime, timeSpan) {
    cr.setLineWidth(2);
    cr.setSourceRGBA(...color);

    let hasPath = false;
    let previousTime = null;

    for (const row of rows) {
        if (!Number.isFinite(row[key])) {
            hasPath = false;
            previousTime = null;
            continue;
        }

        const gapMs = previousTime === null ? 0 : row.time - previousTime;
        const x = padding.left + (((row.time - minTime) / timeSpan) * chartWidth);
        const y = padding.top + chartHeight - ((normalizeChartPercent(row[key]) / 100) * chartHeight);

        if (!hasPath || gapMs > 12 * 60 * 60 * 1000) {
            cr.moveTo(x, y);
            hasPath = true;
        } else {
            cr.lineTo(x, y);
        }

        previousTime = row.time;
    }

    if (hasPath)
        cr.stroke();
}

function normalizeChartPercent(value) {
    if (!Number.isFinite(value))
        return 0;

    return Math.max(0, Math.min(100, value));
}

export default class AIUsageIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(new DisplayPage(settings));
        window.add(new HistoryPage());
        window.add(new AboutPage(this.metadata));
        window.set_default_size(640, 720);
    }
}
