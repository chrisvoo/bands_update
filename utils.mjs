/**
 * Pure helper functions — no I/O, no side effects.
 * All functions here are unit-testable without mocking.
 */

export function parseArgs(argv) {
    return { force: argv.includes('--force') };
}

/** Normalizes "YYYY" year-only strings to "YYYY-01-01". Full dates pass through. */
export function normalizeDate(str) {
    if (!str) return str;
    if (/^\d{4}$/.test(str)) return `${str}-01-01`;
    return str;
}

const EXCLUDED_SECONDARY = new Set(['Compilation', 'Live', 'Soundtrack']);

/** Filters out Live/Compilation/Soundtrack release groups, normalizes dates, sorts newest-first. */
export function filterAndSortReleaseGroups(groups) {
    return groups
        .filter(item => !item['secondary-types']?.some(t => EXCLUDED_SECONDARY.has(t)))
        .map(item => ({
            ...item,
            'first-release-date': normalizeDate(item['first-release-date']),
        }))
        .sort((a, b) => {
            const da = a['first-release-date'] ?? '';
            const db = b['first-release-date'] ?? '';
            return da < db ? 1 : da > db ? -1 : 0;
        });
}

/**
 * Scans bands for duplicate musicbrainz_id or discography_url values.
 * Returns an array of { field, value, bands[] } for each duplicate found.
 */
export function checkDuplicates(bands) {
    const seen = { musicbrainz_id: {}, discography_url: {} };
    const offenders = [];

    for (const [name, info] of Object.entries(bands)) {
        for (const field of ['musicbrainz_id', 'discography_url']) {
            const val = info[field];
            if (!val) continue;
            if (seen[field][val]) {
                const existing = offenders.find(o => o.field === field && o.value === val);
                if (existing) existing.bands.push(name);
                else offenders.push({ field, value: val, bands: [seen[field][val], name] });
            } else {
                seen[field][val] = name;
            }
        }
    }

    return offenders;
}

/** One-time schema migration: fixes the "last_abum" typo if last_album is absent. */
export function migrateBandSchema(band) {
    if (band.last_abum !== undefined && band.last_album === undefined) {
        band.last_album = band.last_abum;
        delete band.last_abum;
    }
    return band;
}

/**
 * Pure state machine for band update logic.
 *
 * Call with latestAlbum=null for a pre-fetch decision (should we even call MB?).
 * Call with a release-group object for a post-fetch decision (what to update?).
 *
 * Actions:
 *   'skip'           – do nothing, don't report
 *   'report_missing' – band.missing set, report without MB call
 *   'fetch'          – proceed with MB API call
 *   'update_check'   – album matches, just update last_check
 *   'set_missing'    – new album found, record as missing
 *   'set_upcoming'   – MB album has a future release date
 *
 * @returns {{ action: string, set: object, unset: string[] }}
 */
export function computeBandUpdate(band, latestAlbum, today, force) {
    const { missing, last_check, upcoming, last_album = '', exclude = [] } = band;

    if (latestAlbum === null) {
        if (!force) {
            if (upcoming && typeof upcoming === 'object' && upcoming.release_date > today) {
                return { action: 'skip', set: {}, unset: [] };
            }
            if (missing) {
                return { action: 'report_missing', set: {}, unset: [] };
            }
            if (last_check === today) {
                return { action: 'skip', set: {}, unset: [] };
            }
        }
        return { action: 'fetch', set: {}, unset: [] };
    }

    // Post-fetch: evaluate the MB result
    const releaseDate = latestAlbum['first-release-date'] ?? '';

    if (releaseDate > today) {
        return {
            action: 'set_upcoming',
            set: {
                upcoming: { album_name: latestAlbum.title, release_date: releaseDate },
                last_check: today,
            },
            unset: [],
        };
    }

    // Album is released (past or today)
    const unset = upcoming ? ['upcoming'] : [];
    const excludeLower = exclude.map(e => e.toLowerCase());
    const titleMatch =
        latestAlbum.title.toLowerCase() === last_album.toLowerCase() ||
        excludeLower.includes(latestAlbum.title.toLowerCase());

    if (titleMatch) {
        if (missing) unset.push('missing');
        return { action: 'update_check', set: { last_check: today }, unset };
    }

    return {
        action: 'set_missing',
        set: { missing: latestAlbum.title, last_check: today },
        unset,
    };
}
