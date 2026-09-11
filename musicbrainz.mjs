import { filterAndSortReleaseGroups } from './utils.mjs';

const API_ROOT_URL = 'https://musicbrainz.org/ws/2';
const MB_HEADERS = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'BandsUpdate/1.0 https://github.com/chrisvoo/bands_update',
};

export class ServerBusyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ServerBusyError';
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isBusyMessage(msg) {
    return msg.toLowerCase().includes('busy');
}

// ponytail: module-level rate limit state, shared across bands. Reset via _resetRateLimit() in tests only.
let lastCallTime = 0;
export function _resetRateLimit() { lastCallTime = 0; }

async function rateLimitedFetch(url, fetchFn, rateLimitMs) {
    const elapsed = Date.now() - lastCallTime;
    const wait = Math.max(0, rateLimitMs - elapsed);
    if (wait > 0) await sleep(wait);
    lastCallTime = Date.now();
    return fetchFn(url, { headers: MB_HEADERS });
}

async function fetchPageWithRetry(url, fetchFn, rateLimitMs, retryDelays) {
    let lastErr;
    for (let i = 0; i < retryDelays.length; i++) {
        try {
            const response = await rateLimitedFetch(url, fetchFn, rateLimitMs);

            if (!response.ok) {
                let msg;
                try {
                    const body = await response.json();
                    msg = body.error?.toString() ?? `HTTP ${response.status}`;
                } catch {
                    msg = `HTTP ${response.status}`;
                }
                throw (response.status === 503 || isBusyMessage(msg))
                    ? new ServerBusyError(msg)
                    : new Error(msg);
            }

            const data = await response.json();
            if (data.error) {
                const msg = data.error.toString();
                throw isBusyMessage(msg) ? new ServerBusyError(msg) : new Error(msg);
            }
            return data;
        } catch (err) {
            lastErr = err;
            if (i < retryDelays.length - 1) await sleep(retryDelays[i]);
        }
    }
    throw lastErr; // preserve ServerBusyError type through all retries
}

/**
 * Fetches all studio album release groups for a given MusicBrainz artist ID.
 *
 * @param {string} bandName - used only for warning messages
 * @param {string} musicbrainz_id - MB artist MBID
 * @param {{ fetchFn?, rateLimitMs?, retryDelays? }} opts
 * @returns {Promise<object[]>} sorted, filtered release groups (newest first)
 */
export async function getReleaseGroups(bandName, musicbrainz_id, {
    fetchFn = globalThis.fetch,
    rateLimitMs = 1500,
    retryDelays = [1000, 2000, 4000],
} = {}) {
    let totalPages = 1;
    let albumRecords = [];

    for (let page = 0; page < totalPages; page++) {
        const params = new URLSearchParams({
            artist: musicbrainz_id,
            type: 'album',
            limit: '100',
            offset: (page * 100).toString(),
        });

        const data = await fetchPageWithRetry(
            `${API_ROOT_URL}/release-group?${params}`,
            fetchFn,
            rateLimitMs,
            retryDelays,
        );

        const groups = data['release-groups'] ?? [];

        if (page === 0) {
            if (!groups.length) {
                console.warn(`\nNo albums found for ${bandName}`);
                return [];
            }
            const total = +data['release-group-count'];
            totalPages = Math.max(1, Math.ceil(total / 100));
        }

        albumRecords = albumRecords.concat(groups);
    }

    return filterAndSortReleaseGroups(albumRecords);
}
