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

const REFRESH_INTERVAL_SECONDS = 60;
const SETTINGS_SHOW_FIVE_HOUR = 'show-five-hour';
const SETTINGS_SHOW_WEEKLY = 'show-weekly';

class CodexUsageIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(extension) {
        super(0.0, 'CodexUsageIndicator');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._refreshId = 0;
        this._refreshInFlight = false;
        this._snapshot = null;
        this._errorMessage = null;

        this._label = new St.Label({
            text: 'CX --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-usage-label',
        });

        this.add_child(this._label);
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

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._menuOpenChangedId) {
            this.menu.disconnect(this._menuOpenChangedId);
            this._menuOpenChangedId = 0;
        }

        super.destroy();
    }

    _buildMenu() {
        this._fiveHourItem = this._createUsageItem('5 hour');
        this._weeklyItem = this._createUsageItem('weekly');
        this._footerItem = this._createFooterItem();

        this.menu.addMenuItem(this._fiveHourItem);
        this.menu.addMenuItem(this._weeklyItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._footerItem);
    }

    _createInfoItem(text) {
        return new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
        });
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
        barFill.width = 0;
        barTrack.add_child(barFill);
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

    _createFooterItem() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'cx-footer-row',
        });

        const updatedLabel = new St.Label({
            text: 'Last update: --',
            x_expand: true,
            style_class: 'cx-footer-label',
        });

        const subscriptionLabel = new St.Label({
            text: '--',
            x_align: Clutter.ActorAlign.END,
            style_class: 'cx-footer-label',
        });

        box.add_child(updatedLabel);
        box.add_child(subscriptionLabel);
        item.add_child(box);
        item.updatedLabel = updatedLabel;
        item.subscriptionLabel = subscriptionLabel;

        return item;
    }

    _connectSignals() {
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._syncLabel();
        });

        this._menuOpenChangedId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                void this._refreshUsage();
        });
    }

    _scheduleRefresh() {
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_SECONDS,
            () => {
                void this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    async _refreshUsage() {
        if (this._refreshInFlight)
            return;

        this._refreshInFlight = true;

        try {
            this._snapshot = await fetchCodexUsageSnapshot();
            this._errorMessage = null;
        } catch (error) {
            this._errorMessage = error?.message ?? 'Unable to load Codex usage.';
        } finally {
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

    _syncLabel() {
        if (!this._snapshot) {
            this._label.text = this._errorMessage ? 'CX !' : 'CX --';
            return;
        }

        const showFiveHour = this._settings.get_boolean(SETTINGS_SHOW_FIVE_HOUR);
        const showWeekly = this._settings.get_boolean(SETTINGS_SHOW_WEEKLY);
        const parts = [];

        if (showFiveHour || !showWeekly)
            parts.push(formatPercent(this._snapshot.fiveHour?.usedPercent));

        if (showWeekly)
            parts.push(formatPercent(this._snapshot.weekly?.usedPercent));

        this._label.text = `CX ${parts.join('/')}`;
    }

    _syncMenu() {
        if (!this._snapshot) {
            const fallback = this._errorMessage ?? 'Loading Codex usage...';
            this._setUsageItem(this._fiveHourItem, '5 hour', fallback, 'resets in --', null);
            this._setUsageItem(this._weeklyItem, 'weekly', '--', 'resets in --', null);
            this._footerItem.updatedLabel.text = 'Last update: --';
            this._footerItem.subscriptionLabel.text = '--';
            return;
        }

        this._setUsageItem(
            this._fiveHourItem,
            '5 hour',
            formatPercent(this._snapshot.fiveHour?.usedPercent),
            formatReset(this._snapshot.fiveHour, 'five-hour'),
            this._snapshot.fiveHour?.usedPercent
        );
        this._setUsageItem(
            this._weeklyItem,
            'weekly',
            formatPercent(this._snapshot.weekly?.usedPercent),
            formatReset(this._snapshot.weekly, 'weekly'),
            this._snapshot.weekly?.usedPercent
        );
        this._footerItem.updatedLabel.text = `Last update: ${formatRelativeTimestamp(this._snapshot.fetchedAt)}`;
        this._footerItem.subscriptionLabel.text = formatPlan(this._snapshot.subscription?.planType ?? this._snapshot.planType);
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

function formatRelativeTimestamp(value) {
    if (!value)
        return '--';

    const timestamp = new Date(value).getTime();

    if (Number.isNaN(timestamp))
        return '--';

    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

    if (diffSeconds < 45)
        return 'just now';

    if (diffSeconds < 3600) {
        const minutes = Math.max(1, Math.floor(diffSeconds / 60));
        return `${minutes} ${minutes === 1 ? 'min' : 'mins'} ago`;
    }

    if (diffSeconds < 86400) {
        const hours = Math.floor(diffSeconds / 3600);
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }

    const days = Math.floor(diffSeconds / 86400);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
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
