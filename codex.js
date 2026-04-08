import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const CODEX_AUTH_PATH = `${GLib.get_home_dir()}/.codex/auth.json`;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'codex-usage-indicator']);
const CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'snapshot.json']);

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export async function readCodexAuthFile() {
    const raw = await readTextFile(CODEX_AUTH_PATH);
    return JSON.parse(raw);
}

export async function readTextFile(path) {
    const file = Gio.File.new_for_path(path);
    const [contents] = await file.load_contents_async(null);

    return new TextDecoder('utf-8').decode(contents);
}

export async function requestUsageQuota(accessToken) {
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

    return snapshot;
}

export function readCachedUsageSnapshot() {
    try {
        const [success, contents] = GLib.file_get_contents(CACHE_PATH);

        if (!success)
            return null;

        const raw = new TextDecoder('utf-8').decode(contents);
        const parsed = JSON.parse(raw);

        return normalizeSnapshot(parsed);
    } catch (_error) {
        return null;
    }
}

export function writeCachedUsageSnapshot(snapshot) {
    try {
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        GLib.file_set_contents(CACHE_PATH, JSON.stringify(snapshot));
    } catch (_error) {
    }
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
        activeStart: tokenAuth.chatgpt_subscription_active_start ?? null,
        activeUntil: tokenAuth.chatgpt_subscription_active_until ?? null,
        lastChecked: tokenAuth.chatgpt_subscription_last_checked ?? null,
        accountId: auth?.tokens?.account_id ?? usage?.account_id ?? null,
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
        activeStart: subscription.activeStart ?? null,
        activeUntil: subscription.activeUntil ?? null,
        lastChecked: subscription.lastChecked ?? null,
        accountId: subscription.accountId ?? null,
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
