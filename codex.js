import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const CODEX_AUTH_PATH = `${GLib.get_home_dir()}/.codex/auth.json`;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'codex-usage-indicator']);
const CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'snapshot.json']);
const HISTORY_PATH = GLib.build_filenamev([CACHE_DIR, "usage-history.csv"]);
const HISTORY_RETENTION_DAYS = 90;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_HEADER = "timestamp,session_used_percent,weekly_used_percent";

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

async function readCodexAuthFile() {
    const raw = await readTextFile(CODEX_AUTH_PATH);
    return JSON.parse(raw);
}

async function readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    const [contents] = await file.load_contents_async(null);

    return new TextDecoder('utf-8').decode(contents);
}

async function requestUsageQuota(accessToken) {
    const token = typeof accessToken === 'string' ? accessToken.trim() : '';

    if (!token)
        throw new Error('Missing Codex access token.');

    const session = new Soup.Session();
    const message = Soup.Message.new('GET', CODEX_USAGE_URL);

    message.request_headers.append('Authorization', `Bearer ${token}`);
    message.request_headers.append('Accept', 'application/json');

    try {
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const body = new TextDecoder('utf-8').decode(bytes.get_data());

        if (message.statusCode !== Soup.Status.OK)
            throw new Error(`Codex usage request failed with HTTP ${message.statusCode}.`);

        return JSON.parse(body);
    } catch (error) {
        throw new Error(error?.message ?? 'Codex usage request failed.');
    }
}

export async function fetchCodexUsageSnapshot() {
    const auth = await readCodexAuthFile();
    const usage = await requestUsageQuota(auth?.tokens?.access_token);
    const snapshot = buildSnapshot(auth, usage, new Date().toISOString());

    writeCachedUsageSnapshot(snapshot);
    writeUsageHistorySample(snapshot);

    return snapshot;
}

export function readCachedUsageSnapshot() {
    try {
        const [success, contents] = GLib.file_get_contents(CACHE_PATH);

        if (!success)
            return null;

        const raw = new TextDecoder("utf-8").decode(contents);
        const parsed = JSON.parse(raw);

        return normalizeSnapshot(parsed);
    } catch (_error) {
        return null;
    }
}

function writeCachedUsageSnapshot(snapshot) {
    try {
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        GLib.file_set_contents(CACHE_PATH, JSON.stringify(snapshot));
    } catch (_error) {
    }
}

function writeUsageHistorySample(snapshot) {
    try {
        const timestamp = snapshot?.fetchedAt;

        if (!timestamp)
            return;

        const rows = readUsageHistoryRows();
        rows.push({
            timestamp,
            sessionUsedPercent: snapshot.fiveHour?.usedPercent ?? null,
            weeklyUsedPercent: snapshot.weekly?.usedPercent ?? null,
        });

        const retainedRows = pruneUsageHistoryRows(rows, new Date(timestamp));

        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        GLib.file_set_contents(HISTORY_PATH, serializeUsageHistoryRows(retainedRows));
    } catch (_error) {
    }
}

function readUsageHistoryRows() {
    try {
        const [success, contents] = GLib.file_get_contents(HISTORY_PATH);

        if (!success)
            return [];

        const raw = new TextDecoder("utf-8").decode(contents);

        return raw
            .split(/\r?\n/)
            .slice(1)
            .filter(line => line.length > 0)
            .map(parseCsvLine)
            .filter(row => row !== null);
    } catch (_error) {
        return [];
    }
}

function pruneUsageHistoryRows(rows, now) {
    const nowTime = now instanceof Date ? now.getTime() : Date.now();
    const cutoffTime = nowTime - HISTORY_RETENTION_MS;

    return rows.filter(row => {
        const rowTime = new Date(row.timestamp).getTime();

        return Number.isFinite(rowTime) && rowTime >= cutoffTime;
    });
}

function serializeUsageHistoryRows(rows) {
    const lines = rows.map(row => [
        escapeCsvValue(row.timestamp),
        escapeCsvValue(row.sessionUsedPercent),
        escapeCsvValue(row.weeklyUsedPercent),
    ].join(","));

    return `${HISTORY_HEADER}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

function escapeCsvValue(value) {
    if (value === null || value === undefined)
        return "";

    const text = value.toString();

    if (!/[",\r\n]/.test(text))
        return text;

    return `"${text.replace(/"/g, "\"\"")}"`;
}

function parseCsvLine(line) {
    const values = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const nextChar = line[index + 1];

        if (char === "\"") {
            if (inQuotes && nextChar === "\"") {
                current += "\"";
                index++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === "," && !inQuotes) {
            values.push(current);
            current = "";
        } else {
            current += char;
        }
    }

    values.push(current);

    if (values.length !== 3)
        return null;

    return {
        timestamp: values[0],
        sessionUsedPercent: parseOptionalNumber(values[1]),
        weeklyUsedPercent: parseOptionalNumber(values[2]),
    };
}

function parseOptionalNumber(value) {
    if (value === "")
        return null;

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}

function buildSnapshot(auth, usage, fetchedAt) {
    const subscription = extractSubscriptionDetails(auth, usage);

    return normalizeSnapshot({
        planType: usage?.plan_type ?? subscription.planType ?? null,
        fetchedAt,
        fiveHour: usage?.rate_limit?.primary_window,
        weekly: usage?.rate_limit?.secondary_window,
        subscription,
    });
}

function normalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object')
        return null;

    return {
        planType: snapshot.planType ?? null,
        fetchedAt: snapshot.fetchedAt ?? null,
        fiveHour: normalizeWindow(snapshot.fiveHour),
        weekly: normalizeWindow(snapshot.weekly),
        subscription: normalizeSubscription(snapshot.subscription),
    };
}

function extractSubscriptionDetails(auth, usage) {
    const idTokenClaims = decodeJwtPayload(auth?.tokens?.id_token);
    const tokenAuth = idTokenClaims?.['https://api.openai.com/auth'] ?? {};

    return {
        planType: usage?.plan_type ?? tokenAuth.chatgpt_plan_type ?? null,
    };
}

function normalizeWindow(window) {
    if (!window)
        return null;

    return {
        usedPercent: getFiniteNumber(window.usedPercent, window.used_percent),
        limitWindowSeconds: getFiniteNumber(window.limitWindowSeconds, window.limit_window_seconds),
        resetAfterSeconds: getFiniteNumber(window.resetAfterSeconds, window.reset_after_seconds),
        resetAt: getFiniteNumber(window.resetAt, window.reset_at),
    };
}

function normalizeSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object')
        return null;

    return {
        planType: subscription.planType ?? null,
    };
}

function getFiniteNumber(...values) {
    for (const value of values) {
        if (Number.isFinite(value))
            return value;
    }

    return null;
}

function decodeJwtPayload(token) {
    if (typeof token !== 'string' || !token.includes('.'))
        return null;

    try {
        const [, payload] = token.split('.');
        const normalized = normalizeBase64Url(payload);
        const decoded = GLib.base64_decode(normalized);
        const json = new TextDecoder('utf-8').decode(decoded);

        return JSON.parse(json);
    } catch (_error) {
        return null;
    }
}

function normalizeBase64Url(value) {
    let normalized = value.replace(/-/g, '+').replace(/_/g, '/');

    while (normalized.length % 4 !== 0)
        normalized += '=';

    return normalized;
}
