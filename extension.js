/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fetchCodexUsageSnapshot, readCachedUsageSnapshot} from './codex.js';

const SETTINGS_SHOW_FIVE_HOUR = 'show-five-hour';
const SETTINGS_SHOW_WEEKLY = 'show-weekly';
const SETTINGS_TOP_BAR_DISPLAY_MODE = 'top-bar-display-mode';
const SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES = 'background-refresh-interval-minutes';
const MIN_REFRESH_INTERVAL_MINUTES = 0;

class CodexUsageIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(extension) {
        super(0.0, 'CodexUsageIndicator');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._refreshId = 0;
        this._refreshSpinId = 0;
        this._refreshInFlight = false;
        this._snapshot = null;
        this._errorMessage = null;

        this._panelBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-panel-box',
        });

        this._prefixLabel = new St.Label({
            text: 'CX',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-panel-prefix',
        });

        this._label = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-usage-label',
        });

        this._panelBars = this._createPanelBars();

        this._panelBox.add_child(this._prefixLabel);
        this._panelBox.add_child(this._label);
        this._panelBox.add_child(this._panelBars);
        this.add_child(this._panelBox);
        this._buildMenu();
        this._connectSignals();
        this._loadCachedSnapshot();

        this._syncLabel();
        this._syncMenu();
        void this._refreshUsage();
        this._scheduleRefresh();
    }

    destroy() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }

        if (this._refreshSpinId) {
            GLib.source_remove(this._refreshSpinId);
            this._refreshSpinId = 0;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._refreshIntervalChangedId) {
            this._settings.disconnect(this._refreshIntervalChangedId);
            this._refreshIntervalChangedId = 0;
        }

        super.destroy();
    }

    _buildMenu() {
        this._headerItem = this._createHeaderItem();
        this._fiveHourItem = this._createUsageItem('Session (5h)');
        this._weeklyItem = this._createUsageItem('Week');
        this._footerItem = this._createFooterItem();

        this.menu.addMenuItem(this._headerItem);
        this.menu.addMenuItem(this._fiveHourItem);
        this.menu.addMenuItem(this._weeklyItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._footerItem);
    }

    _createPanelBars() {
        const box = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-panel-bars',
        });

        this._panelFiveHourBar = this._createPanelBar();
        this._panelWeeklyBar = this._createPanelBar();

        box.add_child(this._panelFiveHourBar.barTrack);
        box.add_child(this._panelWeeklyBar.barTrack);

        return box;
    }

    _createPanelBar() {
        const barTrack = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-panel-bar-track',
        });

        const barFill = new St.Widget({
            y_expand: true,
            style_class: 'cx-usage-bar-fill cx-panel-bar-fill',
        });
        const barSpacer = new St.Widget({
            x_expand: true,
        });

        barFill.width = 0;
        barTrack.add_child(barFill);
        barTrack.add_child(barSpacer);

        const bar = {
            barTrack,
            barFill,
            percentValue: 0,
        };

        barTrack.connect('notify::width', () => {
            this._updateUsageBar(bar);
        });

        return bar;
    }

    _createUsageItem(title) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'cx-usage-menu-item',
        });

        const headingBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'cx-usage-heading-row',
        });

        const titleLabel = new St.Label({
            text: title,
            style_class: 'cx-usage-heading cx-usage-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const valueLabel = new St.Label({
            text: '-- used',
            style_class: 'cx-usage-heading cx-usage-value',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const barTrack = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-usage-bar-track',
        });

        const barFill = new St.Widget({
            y_expand: true,
            style_class: 'cx-usage-bar-fill',
        });
        const barSpacer = new St.Widget({
            x_expand: true,
        });
        barFill.width = 0;
        barTrack.add_child(barFill);
        barTrack.add_child(barSpacer);
        barTrack.connect('notify::width', () => {
            this._updateUsageBar(item);
        });

        const detailLabel = new St.Label({
            text: 'resets in --',
            x_expand: true,
            style_class: 'cx-usage-detail',
        });

        headingBox.add_child(titleLabel);
        headingBox.add_child(valueLabel);

        box.add_child(headingBox);
        box.add_child(barTrack);
        box.add_child(detailLabel);
        item.add_child(box);
        item.titleLabel = titleLabel;
        item.valueLabel = valueLabel;
        item.barTrack = barTrack;
        item.barFill = barFill;
        item.percentValue = 0;
        item.detailLabel = detailLabel;

        return item;
    }

    _createHeaderItem() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'cx-header-item',
        });

        const topRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-header-row',
        });

        const refreshButton = new St.Button({
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'popup-menu-icon',
            }),
            style_class: 'cx-footer-button',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const refreshIcon = refreshButton.child;
        refreshIcon.set_pivot_point(0.5, 0.5);
        refreshButton.connect('clicked', () => {
            void this._refreshUsage({manual: true});
        });

        const datetimeLabel = new St.Label({
            text: '--',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-header-detail',
        });

        topRow.add_child(datetimeLabel);
        topRow.add_child(refreshButton);
        box.add_child(topRow);
        item.add_child(box);
        item.datetimeLabel = datetimeLabel;
        item.refreshIcon = refreshIcon;
        item.refreshButton = refreshButton;

        return item;
    }

    _createFooterItem() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-footer-row',
        });

        const planLabel = new St.Label({
            text: '--',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-footer-label',
        });

        const settingsButton = new St.Button({
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'popup-menu-icon',
            }),
            style_class: 'cx-footer-button',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        settingsButton.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });

        box.add_child(planLabel);
        box.add_child(settingsButton);
        item.add_child(box);
        item.planLabel = planLabel;
        item.settingsButton = settingsButton;

        return item;
    }

    _connectSignals() {
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._syncLabel();
        });

        this._refreshIntervalChangedId = this._settings.connect(
            `changed::${SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES}`,
            () => {
                this._scheduleRefresh();
            }
        );
    }

    _scheduleRefresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }

        const refreshIntervalSeconds = this._getRefreshIntervalSeconds();

        if (refreshIntervalSeconds <= 0)
            return;

        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            refreshIntervalSeconds,
            () => {
                void this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    async _refreshUsage({manual = false} = {}) {
        if (this._refreshInFlight)
            return;

        this._refreshInFlight = true;

        if (manual)
            this._startRefreshSpin();

        try {
            this._snapshot = await fetchCodexUsageSnapshot();
            this._errorMessage = null;
        } catch (error) {
            this._errorMessage = error?.message ?? 'Unable to load Codex usage.';
        } finally {
            if (manual)
                this._stopRefreshSpin();
            this._refreshInFlight = false;
            this._syncLabel();
            this._syncMenu();
        }
    }

    _loadCachedSnapshot() {
        const snapshot = readCachedUsageSnapshot();

        if (snapshot)
            this._snapshot = snapshot;
    }

    _getRefreshIntervalSeconds() {
        const intervalMinutes = this._settings.get_uint(SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES);
        const safeMinutes = Math.max(MIN_REFRESH_INTERVAL_MINUTES, intervalMinutes);

        if (safeMinutes === 0)
            return 0;

        return safeMinutes * 60;
    }

    _startRefreshSpin() {
        if (!this._headerItem?.refreshIcon || this._refreshSpinId)
            return;

        this._headerItem.refreshButton.reactive = false;
        this._headerItem.refreshButton.can_focus = false;

        this._refreshSpinId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            30,
            () => {
                this._headerItem.refreshIcon.rotation_angle_z =
                    (this._headerItem.refreshIcon.rotation_angle_z + 18) % 360;
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopRefreshSpin() {
        if (this._refreshSpinId) {
            GLib.source_remove(this._refreshSpinId);
            this._refreshSpinId = 0;
        }

        if (!this._headerItem?.refreshIcon)
            return;

        this._headerItem.refreshIcon.rotation_angle_z = 0;
        this._headerItem.refreshButton.reactive = true;
        this._headerItem.refreshButton.can_focus = true;
    }

    _syncLabel() {
        const showFiveHour = this._settings.get_boolean(SETTINGS_SHOW_FIVE_HOUR);
        const showWeekly = this._settings.get_boolean(SETTINGS_SHOW_WEEKLY);
        const displayMode = this._settings.get_string(SETTINGS_TOP_BAR_DISPLAY_MODE);
        const includeFiveHour = showFiveHour || !showWeekly;

        this._panelFiveHourBar.barTrack.visible = includeFiveHour;
        this._panelWeeklyBar.barTrack.visible = showWeekly;

        if (this._snapshot) {
            this._panelFiveHourBar.percentValue = normalizePercent(this._snapshot.fiveHour?.usedPercent);
            this._panelWeeklyBar.percentValue = normalizePercent(this._snapshot.weekly?.usedPercent);
            this._updateUsageBarColor(this._panelFiveHourBar);
            this._updateUsageBarColor(this._panelWeeklyBar);
            this._updateUsageBar(this._panelFiveHourBar);
            this._updateUsageBar(this._panelWeeklyBar);
        } else {
            this._panelFiveHourBar.percentValue = 0;
            this._panelWeeklyBar.percentValue = 0;
            this._updateUsageBar(this._panelFiveHourBar);
            this._updateUsageBar(this._panelWeeklyBar);
        }

        const showPanelBars = displayMode === 'bars' && this._snapshot;
        this._panelBars.visible = showPanelBars;
        this._label.visible = !showPanelBars;

        if (showPanelBars)
            return;

        if (!this._snapshot) {
            this._label.text = this._errorMessage ? '!' : '--';
            return;
        }

        const parts = [];

        if (includeFiveHour)
            parts.push(formatPercent(this._snapshot.fiveHour?.usedPercent));

        if (showWeekly)
            parts.push(formatPercent(this._snapshot.weekly?.usedPercent));

        this._label.text = parts.join('/');
    }

    _syncMenu() {
        if (!this._snapshot) {
            const fallback = this._errorMessage ?? 'Loading Codex usage...';
            this._headerItem.datetimeLabel.text = '--';
            this._setUsageItem(this._fiveHourItem, 'Session (5h)', fallback, 'resets in --', null);
            this._setUsageItem(this._weeklyItem, 'Week', '--', 'resets in --', null);
            this._footerItem.planLabel.text = '--';
            return;
        }

        this._headerItem.datetimeLabel.text = formatUpdatedAt(this._snapshot.fetchedAt);
        this._setUsageItem(
            this._fiveHourItem,
            'Session (5h)',
            formatPercent(this._snapshot.fiveHour?.usedPercent),
            formatReset(this._snapshot.fiveHour, 'five-hour'),
            this._snapshot.fiveHour?.usedPercent
        );
        this._setUsageItem(
            this._weeklyItem,
            'Week',
            formatPercent(this._snapshot.weekly?.usedPercent),
            formatReset(this._snapshot.weekly, 'weekly'),
            this._snapshot.weekly?.usedPercent
        );
        this._footerItem.planLabel.text = formatPlan(this._snapshot.subscription?.planType ?? this._snapshot.planType);
    }

    _setUsageItem(item, title, value, detail, percentValue) {
        item.titleLabel.text = title;
        item.valueLabel.text = `${value} used`;
        item.detailLabel.text = detail;
        item.percentValue = normalizePercent(percentValue);
        this._updateUsageBarColor(item);
        this._updateUsageBar(item);
    }

    _updateUsageBar(item) {
        const trackWidth = item.barTrack.width;
        const percent = item.percentValue ?? 0;

        if (trackWidth <= 0) {
            item.barFill.width = 0;
            return;
        }

        item.barFill.width = Math.round(trackWidth * (percent / 100));
    }

    _updateUsageBarColor(item) {
        item.barFill.remove_style_class_name('cx-usage-bar-fill-green');
        item.barFill.remove_style_class_name('cx-usage-bar-fill-orange');
        item.barFill.remove_style_class_name('cx-usage-bar-fill-red');

        const percent = item.percentValue ?? 0;

        if (percent > 95) {
            item.barFill.add_style_class_name('cx-usage-bar-fill-red');
            return;
        }

        if (percent > 75) {
            item.barFill.add_style_class_name('cx-usage-bar-fill-orange');
            return;
        }

        item.barFill.add_style_class_name('cx-usage-bar-fill-green');
    }
}

function formatPercent(value) {
    return Number.isFinite(value) ? `${value}%` : '--';
}

function formatReset(window, windowType) {
    if (!window)
        return 'resets in --';

    const relative = formatDuration(window.resetAfterSeconds, windowType);
    const absolute = formatUnixTimestamp(window.resetAt);

    if (relative === '--' && absolute === '--')
        return 'resets in --';

    if (relative === '--')
        return `resets in -- (${absolute})`;

    if (absolute === '--')
        return `resets in ${relative}`;

    return `resets in ${relative} (${absolute})`;
}

function formatDuration(totalSeconds, windowType) {
    if (!Number.isFinite(totalSeconds))
        return '--';

    let remaining = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(remaining / 86400);
    remaining %= 86400;
    const hours = Math.floor(remaining / 3600);
    remaining %= 3600;
    const minutes = Math.floor(remaining / 60);

    if (windowType === 'five-hour')
        return `${hours}h ${minutes}m`;

    if (windowType === 'weekly')
        return `${days}d ${hours}h`;

    const parts = [];

    if (days)
        parts.push(`${days}d`);

    if (hours)
        parts.push(`${hours}h`);

    if (minutes || parts.length === 0)
        parts.push(`${minutes}m`);

    return parts.join(' ');
}

function formatUnixTimestamp(value) {
    if (!Number.isFinite(value))
        return '--';

    return formatTimestamp(new Date(value * 1000).toISOString());
}

function formatTimestamp(value) {
    if (!value)
        return '--';

    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(new Date(value));
    } catch (_error) {
        return '--';
    }
}

function formatUpdatedAt(value) {
    if (!value)
        return '--';

    try {
        return 'Updated at ' + new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date(value));
    } catch (_error) {
        return '--';
    }
}

function formatPlan(value) {
    if (!value)
        return '--';

    return value
        .toString()
        .split(/[_-]/)
        .filter(Boolean)
        .map(part => `${part[0].toUpperCase()}${part.slice(1)}`)
        .join(' ');
}

function normalizePercent(value) {
    if (!Number.isFinite(value))
        return 0;

    return Math.max(0, Math.min(100, value));
}

export default class AIUsageIndicatorExtension extends Extension {
    enable() {
        this._indicator = new CodexUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
