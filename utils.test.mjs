import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseArgs,
    normalizeDate,
    filterAndSortReleaseGroups,
    checkDuplicates,
    migrateBandSchema,
    computeBandUpdate,
} from './utils.mjs';

describe('parseArgs', () => {
    it('returns force: false when --force absent', () => {
        assert.deepEqual(parseArgs(['node', 'index.mjs']), { force: false });
    });
    it('returns force: true when --force present', () => {
        assert.deepEqual(parseArgs(['node', 'index.mjs', '--force']), { force: true });
    });
    it('ignores unknown flags', () => {
        assert.deepEqual(parseArgs(['node', 'index.mjs', '--verbose']), { force: false });
    });
});

describe('normalizeDate', () => {
    it('expands 4-digit year to full date', () => {
        assert.equal(normalizeDate('2024'), '2024-01-01');
    });
    it('passes full ISO date through unchanged', () => {
        assert.equal(normalizeDate('2024-06-15'), '2024-06-15');
    });
    it('passes partial date (YYYY-MM) through unchanged', () => {
        assert.equal(normalizeDate('2024-06'), '2024-06');
    });
    it('returns null/undefined as-is', () => {
        assert.equal(normalizeDate(null), null);
        assert.equal(normalizeDate(undefined), undefined);
    });
});

describe('filterAndSortReleaseGroups', () => {
    const make = (title, date, secondary = []) => ({
        title,
        'first-release-date': date,
        'secondary-types': secondary,
    });

    it('removes Live release groups', () => {
        const result = filterAndSortReleaseGroups([make('Studio', '2020-01-01'), make('Live X', '2021-01-01', ['Live'])]);
        assert.equal(result.length, 1);
        assert.equal(result[0].title, 'Studio');
    });

    it('removes Compilation release groups', () => {
        const result = filterAndSortReleaseGroups([make('Studio', '2020-01-01'), make('Hits', '2021-01-01', ['Compilation'])]);
        assert.equal(result.length, 1);
    });

    it('removes Soundtrack release groups', () => {
        const result = filterAndSortReleaseGroups([make('Studio', '2020-01-01'), make('OST', '2021-01-01', ['Soundtrack'])]);
        assert.equal(result.length, 1);
    });

    it('sorts newest first', () => {
        const input = [make('Old', '2018-01-01'), make('New', '2022-01-01'), make('Mid', '2020-01-01')];
        const result = filterAndSortReleaseGroups(input);
        assert.deepEqual(result.map(r => r.title), ['New', 'Mid', 'Old']);
    });

    it('normalizes year-only dates', () => {
        const result = filterAndSortReleaseGroups([make('Album', '2022')]);
        assert.equal(result[0]['first-release-date'], '2022-01-01');
    });

    it('keeps items without secondary-types', () => {
        const item = { title: 'No Types', 'first-release-date': '2020-01-01' };
        const result = filterAndSortReleaseGroups([item]);
        assert.equal(result.length, 1);
    });
});

describe('checkDuplicates', () => {
    it('returns empty array when all values are unique', () => {
        const bands = {
            A: { musicbrainz_id: 'id1', discography_url: 'url1' },
            B: { musicbrainz_id: 'id2', discography_url: 'url2' },
        };
        assert.deepEqual(checkDuplicates(bands), []);
    });

    it('detects duplicate musicbrainz_id', () => {
        const bands = {
            A: { musicbrainz_id: 'same', discography_url: 'url1' },
            B: { musicbrainz_id: 'same', discography_url: 'url2' },
        };
        const result = checkDuplicates(bands);
        assert.equal(result.length, 1);
        assert.equal(result[0].field, 'musicbrainz_id');
        assert.equal(result[0].value, 'same');
        assert.deepEqual(result[0].bands, ['A', 'B']);
    });

    it('detects duplicate discography_url', () => {
        const bands = {
            X: { musicbrainz_id: 'id1', discography_url: 'same-url' },
            Y: { musicbrainz_id: 'id2', discography_url: 'same-url' },
        };
        const result = checkDuplicates(bands);
        assert.equal(result.length, 1);
        assert.equal(result[0].field, 'discography_url');
    });

    it('handles missing discography_url gracefully', () => {
        const bands = {
            A: { musicbrainz_id: 'id1' },
            B: { musicbrainz_id: 'id2' },
        };
        assert.deepEqual(checkDuplicates(bands), []);
    });

    it('collects three bands sharing the same id', () => {
        const bands = {
            A: { musicbrainz_id: 'shared' },
            B: { musicbrainz_id: 'shared' },
            C: { musicbrainz_id: 'shared' },
        };
        const result = checkDuplicates(bands);
        assert.equal(result.length, 1);
        assert.deepEqual(result[0].bands, ['A', 'B', 'C']);
    });
});

describe('migrateBandSchema', () => {
    it('renames last_abum to last_album when last_album is absent', () => {
        const band = { last_abum: 'Test Album' };
        migrateBandSchema(band);
        assert.equal(band.last_album, 'Test Album');
        assert.equal(band.last_abum, undefined);
    });

    it('does not overwrite existing last_album', () => {
        const band = { last_abum: 'Typo', last_album: 'Real' };
        migrateBandSchema(band);
        assert.equal(band.last_album, 'Real');
        assert.equal(band.last_abum, 'Typo');
    });

    it('does nothing when neither typo nor last_album present', () => {
        const band = { musicbrainz_id: 'test' };
        migrateBandSchema(band);
        assert.equal(band.last_album, undefined);
    });
});

describe('computeBandUpdate — pre-fetch decisions', () => {
    const TODAY = '2026-09-11';
    const FUTURE = '2027-01-01';

    it('skips when upcoming is a future-dated object and force=false', () => {
        const band = { upcoming: { album_name: 'Next', release_date: FUTURE } };
        assert.equal(computeBandUpdate(band, null, TODAY, false).action, 'skip');
    });

    it('fetches when upcoming is future but force=true', () => {
        const band = { upcoming: { album_name: 'Next', release_date: FUTURE } };
        assert.equal(computeBandUpdate(band, null, TODAY, true).action, 'fetch');
    });

    it('skips when upcoming=true (old format) is overridden by missing check', () => {
        // upcoming: true is not an object, so the upcoming check is skipped
        // missing check comes next
        const band = { upcoming: true, missing: 'New Album' };
        assert.equal(computeBandUpdate(band, null, TODAY, false).action, 'report_missing');
    });

    it('reports missing when band.missing is set and force=false', () => {
        const band = { missing: 'New Album' };
        assert.equal(computeBandUpdate(band, null, TODAY, false).action, 'report_missing');
    });

    it('fetches even when missing is set if force=true', () => {
        const band = { missing: 'New Album' };
        assert.equal(computeBandUpdate(band, null, TODAY, true).action, 'fetch');
    });

    it('skips when last_check is today and force=false', () => {
        const band = { last_check: TODAY };
        assert.equal(computeBandUpdate(band, null, TODAY, false).action, 'skip');
    });

    it('fetches when last_check is today but force=true', () => {
        const band = { last_check: TODAY };
        assert.equal(computeBandUpdate(band, null, TODAY, true).action, 'fetch');
    });

    it('fetches when no skip conditions apply', () => {
        const band = { last_check: '2026-01-01' };
        assert.equal(computeBandUpdate(band, null, TODAY, false).action, 'fetch');
    });
});

describe('computeBandUpdate — post-fetch decisions', () => {
    const TODAY = '2026-09-11';
    const FUTURE = '2027-01-01';
    const PAST = '2023-01-01';

    const makeAlbum = (title, date) => ({ title, 'first-release-date': date });

    it('sets upcoming when MB album has future release date', () => {
        const band = { last_album: 'Old Album' };
        const { action, set } = computeBandUpdate(band, makeAlbum('Coming Soon', FUTURE), TODAY, false);
        assert.equal(action, 'set_upcoming');
        assert.deepEqual(set.upcoming, { album_name: 'Coming Soon', release_date: FUTURE });
        assert.equal(set.last_check, TODAY);
    });

    it('updates last_check when MB album matches last_album', () => {
        const band = { last_album: 'Same Album' };
        const { action, set } = computeBandUpdate(band, makeAlbum('Same Album', PAST), TODAY, false);
        assert.equal(action, 'update_check');
        assert.equal(set.last_check, TODAY);
    });

    it('is case-insensitive when matching album title', () => {
        const band = { last_album: 'same album' };
        assert.equal(computeBandUpdate(band, makeAlbum('Same Album', PAST), TODAY, false).action, 'update_check');
    });

    it('treats excluded titles as a match (no missing)', () => {
        const band = { last_album: 'Old Album', exclude: ['Live Bootleg'] };
        assert.equal(computeBandUpdate(band, makeAlbum('Live Bootleg', PAST), TODAY, false).action, 'update_check');
    });

    it('sets missing when MB album differs from last_album', () => {
        const band = { last_album: 'Old Album' };
        const { action, set } = computeBandUpdate(band, makeAlbum('New Album', PAST), TODAY, false);
        assert.equal(action, 'set_missing');
        assert.equal(set.missing, 'New Album');
        assert.equal(set.last_check, TODAY);
    });

    it('clears existing missing field when album now matches', () => {
        const band = { last_album: 'Same Album', missing: 'Stale Entry' };
        const { action, unset } = computeBandUpdate(band, makeAlbum('Same Album', PAST), TODAY, false);
        assert.equal(action, 'update_check');
        assert.ok(unset.includes('missing'));
    });

    it('clears upcoming field when MB album is now released', () => {
        const band = {
            last_album: 'Old',
            upcoming: { album_name: 'Now Released', release_date: PAST },
        };
        const { unset } = computeBandUpdate(band, makeAlbum('Now Released', PAST), TODAY, false);
        assert.ok(unset.includes('upcoming'));
    });
});
