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

import {fetchCodexUsageSnapshot, readCachedUsageSnapshot, readUsageHistory} from './codex.js';

const SETTINGS_SHOW_FIVE_HOUR = 'show-five-hour';
const SETTINGS_SHOW_WEEKLY = 'show-weekly';
const SETTINGS_TOP_BAR_DISPLAY_MODE = 'top-bar-display-mode';
const SETTINGS_BACKGROUND_REFRESH_INTERVAL_MINUTES = 'background-refresh-interval-minutes';
const MIN_REFRESH_INTERVAL_MINUTES = 0;
const SESSION_PREDICTION_REQUIREMENTS = {
    minSamples: 4,
    minTimespanMs: 15 * 60 * 1000,
    minGrowthPercent: 1,
};
const WEEKLY_PREDICTION_REQUIREMENTS = {
    minSamples: 12,
    minTimespanMs: 6 * 60 * 60 * 1000,
    minGrowthPercent: 2,
};

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
        this._menuSyncId = 0;
        this._refreshInFlight = false;
        this._snapshot = null;
        this._historyRows = [];
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
        this._loadHistory();

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

        if (this._menuSyncId) {
            GLib.source_remove(this._menuSyncId);
            this._menuSyncId = 0;
        }

        if (this._menuOpenChangedId) {
            this.menu.disconnect(this._menuOpenChangedId);
            this._menuOpenChangedId = 0;
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

        const detailBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'cx-usage-detail',
        });
        const predictionLabel = new St.Label({
            text: 'Trend unavailable',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const detailSeparatorLabel = new St.Label({
            text: ' · ',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-usage-detail-muted',
        });
        const resetLabel = new St.Label({
            text: 'resets in --',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cx-usage-detail-muted',
        });

        detailBox.add_child(predictionLabel);
        detailBox.add_child(detailSeparatorLabel);
        detailBox.add_child(resetLabel);

        headingBox.add_child(titleLabel);
        headingBox.add_child(valueLabel);

        box.add_child(headingBox);
        box.add_child(barTrack);
        box.add_child(detailBox);
        item.add_child(box);
        item.titleLabel = titleLabel;
        item.valueLabel = valueLabel;
        item.barTrack = barTrack;
        item.barFill = barFill;
        item.percentValue = 0;
        item.predictionLabel = predictionLabel;
        item.resetLabel = resetLabel;

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
        this._menuOpenChangedId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._queueMenuBarSync();
        });

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
            this._loadHistory();
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

    _loadHistory() {
        this._historyRows = readUsageHistory();
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
        const hasTopBarUsage = showFiveHour || showWeekly;
        const includeFiveHour = showFiveHour;
        const showUnifiedBar = displayMode === 'unified' && this._snapshot && hasTopBarUsage;
        const showSplitBars = displayMode === 'bars' && this._snapshot && hasTopBarUsage;

        if (showUnifiedBar) {
            this._panelFiveHourBar.barTrack.visible = true;
            this._panelWeeklyBar.barTrack.visible = false;
        } else {
            this._panelFiveHourBar.barTrack.visible = includeFiveHour;
            this._panelWeeklyBar.barTrack.visible = showWeekly;
        }

        if (this._snapshot) {
            if (showUnifiedBar) {
                if (showFiveHour && showWeekly) {
                    this._panelFiveHourBar.percentValue = calculateUnifiedPercent(
                        this._snapshot.fiveHour?.usedPercent,
                        this._snapshot.weekly?.usedPercent
                    );
                } else if (showFiveHour) {
                    this._panelFiveHourBar.percentValue = normalizePercent(this._snapshot.fiveHour?.usedPercent);
                } else {
                    this._panelFiveHourBar.percentValue = normalizePercent(this._snapshot.weekly?.usedPercent);
                }

                this._panelWeeklyBar.percentValue = 0;
            } else {
                this._panelFiveHourBar.percentValue = normalizePercent(this._snapshot.fiveHour?.usedPercent);
                this._panelWeeklyBar.percentValue = normalizePercent(this._snapshot.weekly?.usedPercent);
            }

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

        this._panelBars.visible = showSplitBars || showUnifiedBar;
        this._label.visible = !(showSplitBars || showUnifiedBar);

        if (showSplitBars || showUnifiedBar)
            return;

        if (!hasTopBarUsage) {
            this._label.text = '';
            return;
        }

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
            this._setUsageItem(this._fiveHourItem, 'Session (5h)', fallback, 'Trend unavailable', 'resets in --', null, 'muted');
            this._setUsageItem(this._weeklyItem, 'Week', '--', 'Trend unavailable', 'resets in --', null, 'muted');
            this._footerItem.planLabel.text = '--';
            return;
        }

        const now = Date.now();
        const fiveHourPrediction = predictLimitHit(
            this._snapshot.fiveHour,
            this._snapshot,
            this._historyRows,
            'sessionUsedPercent',
            now,
            SESSION_PREDICTION_REQUIREMENTS
        );
        const weeklyPrediction = predictLimitHit(
            this._snapshot.weekly,
            this._snapshot,
            this._historyRows,
            'weeklyUsedPercent',
            now,
            WEEKLY_PREDICTION_REQUIREMENTS
        );

        this._headerItem.datetimeLabel.text = formatUpdatedAt(this._snapshot.fetchedAt);
        this._setUsageItem(
            this._fiveHourItem,
            'Session (5h)',
            formatPercent(this._snapshot.fiveHour?.usedPercent),
            formatLimitPrediction(fiveHourPrediction, 'five-hour'),
            formatReset(this._snapshot.fiveHour, 'five-hour'),
            this._snapshot.fiveHour?.usedPercent,
            getPredictionStyleClass(fiveHourPrediction)
        );
        this._setUsageItem(
            this._weeklyItem,
            'Week',
            formatPercent(this._snapshot.weekly?.usedPercent),
            formatLimitPrediction(weeklyPrediction, 'weekly'),
            formatReset(this._snapshot.weekly, 'weekly'),
            this._snapshot.weekly?.usedPercent,
            getPredictionStyleClass(weeklyPrediction)
        );
        this._footerItem.planLabel.text = formatPlan(this._snapshot.subscription?.planType ?? this._snapshot.planType);
    }

    _queueMenuBarSync() {
        if (this._menuSyncId)
            return;

        this._menuSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._menuSyncId = 0;
            this._updateUsageBar(this._fiveHourItem);
            this._updateUsageBar(this._weeklyItem);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setUsageItem(item, title, value, prediction, reset, percentValue, predictionStyle = 'muted') {
        item.titleLabel.text = title;
        item.valueLabel.text = `${value} used`;
        item.predictionLabel.text = prediction;
        item.resetLabel.text = reset;
        setPredictionStyleClass(item.predictionLabel, predictionStyle);
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
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
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

function predictLimitHit(window, snapshot, historyRows, key, now = Date.now(), requirements = SESSION_PREDICTION_REQUIREMENTS) {
    if (!window)
        return createPrediction('unavailable');

    const latestPercent = clampPredictionPercent(window.usedPercent);

    if (!Number.isFinite(latestPercent))
        return createPrediction('unavailable');

    if (latestPercent >= 100)
        return createPrediction('already-limited', now, 0);

    const resetAt = Number.isFinite(window.resetAt) ? window.resetAt * 1000 : null;
    const limitWindowMs = Number.isFinite(window.limitWindowSeconds)
        ? window.limitWindowSeconds * 1000
        : null;

    if (!Number.isFinite(resetAt) || !Number.isFinite(limitWindowMs) || limitWindowMs <= 0)
        return createPrediction('unavailable');

    const windowStart = resetAt - limitWindowMs;
    const samples = historyRows
        .map(row => ({
            time: new Date(row.timestamp).getTime(),
            percent: clampPredictionPercent(row[key]),
        }))
        .filter(sample =>
            Number.isFinite(sample.time) &&
            sample.time >= windowStart &&
            sample.time <= resetAt &&
            Number.isFinite(sample.percent)
        );

    const currentTime = new Date(snapshot?.fetchedAt).getTime();

    if (Number.isFinite(currentTime)) {
        const lastSample = samples[samples.length - 1];

        if (!lastSample || lastSample.time !== currentTime || lastSample.percent !== latestPercent)
            samples.push({time: currentTime, percent: latestPercent});
    }

    samples.sort((left, right) => left.time - right.time);

    const dedupedSamples = [];
    for (const sample of samples) {
        const previous = dedupedSamples[dedupedSamples.length - 1];

        if (previous?.time === sample.time) {
            previous.percent = sample.percent;
            continue;
        }

        dedupedSamples.push(sample);
    }

    if (dedupedSamples.length < requirements.minSamples)
        return createPrediction('unavailable');

    const first = dedupedSamples[0];
    const latest = dedupedSamples[dedupedSamples.length - 1];
    const elapsedMs = latest.time - first.time;
    const percentGrowth = latest.percent - first.percent;

    if (elapsedMs < requirements.minTimespanMs || percentGrowth < requirements.minGrowthPercent)
        return createPrediction('unavailable');

    const percentPerMs = calculateTrendSlope(dedupedSamples);

    if (!Number.isFinite(percentPerMs) || percentPerMs <= 0)
        return createPrediction('unavailable');

    const msToLimit = (100 - latest.percent) / percentPerMs;
    const predictedAt = latest.time + msToLimit;
    const secondsUntilLimit = Math.max(0, Math.round((predictedAt - now) / 1000));

    if (!Number.isFinite(predictedAt) || !Number.isFinite(secondsUntilLimit))
        return createPrediction('unavailable');

    if (predictedAt < resetAt)
        return createPrediction('before-reset', predictedAt, secondsUntilLimit);

    return createPrediction('safe', predictedAt, secondsUntilLimit);
}

function calculateTrendSlope(samples) {
    const originTime = samples[0].time;
    const meanTime = samples.reduce((sum, sample) => sum + (sample.time - originTime), 0) / samples.length;
    const meanPercent = samples.reduce((sum, sample) => sum + sample.percent, 0) / samples.length;
    let covariance = 0;
    let variance = 0;

    for (const sample of samples) {
        const timeDelta = (sample.time - originTime) - meanTime;
        const percentDelta = sample.percent - meanPercent;

        covariance += timeDelta * percentDelta;
        variance += timeDelta * timeDelta;
    }

    if (variance <= 0)
        return null;

    return covariance / variance;
}

function createPrediction(status, predictedAt = null, secondsUntilLimit = null) {
    return {
        status,
        predictedAt,
        secondsUntilLimit,
    };
}

function formatLimitPrediction(prediction, windowType) {
    switch (prediction?.status) {
    case 'already-limited':
        return 'Limit reached';
    case 'before-reset':
        return `Limit in ${formatDuration(prediction.secondsUntilLimit, windowType)}`;
    case 'safe':
        return 'Safe until reset';
    default:
        return 'Trend unavailable';
    }
}

function getPredictionStyleClass(prediction) {
    switch (prediction?.status) {
    case 'already-limited':
        return 'danger';
    case 'before-reset':
        return prediction.secondsUntilLimit < 30 * 60 ? 'danger' : 'warning';
    case 'safe':
        return 'safe';
    default:
        return 'muted';
    }
}

function setPredictionStyleClass(label, style) {
    label.remove_style_class_name('cx-usage-prediction-safe');
    label.remove_style_class_name('cx-usage-prediction-warning');
    label.remove_style_class_name('cx-usage-prediction-danger');
    label.remove_style_class_name('cx-usage-prediction-muted');
    label.add_style_class_name(`cx-usage-prediction-${style}`);
}

function clampPredictionPercent(value) {
    if (!Number.isFinite(value))
        return null;

    return Math.max(0, Math.min(100, value));
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

function calculateUnifiedPercent(...values) {
    const normalizedValues = values
        .filter(Number.isFinite)
        .map(value => normalizePercent(value) / 100);

    if (normalizedValues.length === 0)
        return 0;

    const remainingCapacity = normalizedValues.reduce(
        (remaining, value) => remaining * (1 - value),
        1
    );

    return Math.round((1 - remainingCapacity) * 100);
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
