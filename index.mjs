import { readFile, writeFile } from 'fs/promises';
import process from 'node:process';
import cliProgress from 'cli-progress';
import Table from 'cli-table3';
import { parseArgs, checkDuplicates, computeBandUpdate, migrateBandSchema } from './utils.mjs';
import { getReleaseGroups, ServerBusyError } from './musicbrainz.mjs';

const CHECKS_FILE = './checks.json';
const TODAY = new Date().toISOString().slice(0, 10);
const SUMMARY_FILE = './latest_check_results.txt';
const red = str => `\x1b[31m${str}\x1b[0m`;
const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, '');

async function loadBands() {
    const raw = await readFile(CHECKS_FILE, { encoding: 'utf8' });
    return JSON.parse(raw);
}

async function writeBands(bands) {
    await writeFile(CHECKS_FILE, JSON.stringify(bands, null, 4), 'utf8');
}

function applyDecision(band, decision) {
    Object.assign(band, decision.set);
    for (const k of decision.unset) delete band[k];
}

function buildSummary(results, elapsedMs) {
    const parts = [];
    if (!results.length) {
        parts.push('\nNo new albums found.');
    } else {
        parts.push('\nNew or missing albums:');
        const table = new Table({
            head: ['Band', 'Status', 'Album', 'Release Date'],
            style: { head: ['cyan'] },
        });
        for (const { bandName, action, album, releaseDate } of results) {
            const status = action === 'set_missing' ? 'NEW' : 'STILL MISSING';
            table.push([bandName, status, album ?? '', releaseDate ?? '']);
        }
        parts.push(table.toString());
    }
    parts.push(`\nCompleted in ${(elapsedMs / 1000).toFixed(1)}s`);
    return parts.join('\n');
}

(async () => {
    const { force } = parseArgs(process.argv);
    const startTime = Date.now();

    let bands;
    try {
        bands = await loadBands();
    } catch (err) {
        console.error(red('Failed to load checks.json:'), err.message);
        process.exit(1);
    }

    for (const band of Object.values(bands)) {
        migrateBandSchema(band);
    }

    const dupes = checkDuplicates(bands);
    if (dupes.length) {
        console.error(red('Duplicate entries found — fix these before running:\n'));
        for (const { field, value, bands: names } of dupes) {
            console.error(`  ${field}: "${value}"\n    → ${names.join(', ')}`);
        }
        process.exit(1);
    }

    await writeFile(SUMMARY_FILE, '', 'utf8').catch(() => {});

    const entries = Object.entries(bands);
    const results = [];
    let fatalError = null;
    let newAlbumsCount = 0;
    let rateLimitMs = 1000;
    let busyIncreases = 0;
    const MAX_BUSY_INCREASES = 3;
    const BUSY_INCREMENT_MS = 250;

    const bar = new cliProgress.SingleBar({
        format: '[{bar}] {value}/{total} ({percentage}%) | 🔥 {newAlbums} | {band}',
        clearOnComplete: false,
        hideCursor: true,
    }, cliProgress.Presets.shades_classic);
    bar.start(entries.length, 0, { band: '', newAlbums: 0 });

    try {
        for (const [bandName, band] of entries) {
            bar.increment({ band: bandName, newAlbums: newAlbumsCount });

            const preFetch = computeBandUpdate(band, null, TODAY, force);

            if (preFetch.action === 'skip') continue;

            if (preFetch.action === 'report_missing') {
                results.push({
                    bandName,
                    action: 'report_missing',
                    album: band.missing,
                    releaseDate: band.last_album_release_date,
                });
                continue;
            }

            let albums;
            while (true) {
                try {
                    albums = await getReleaseGroups(bandName, band.musicbrainz_id, { rateLimitMs });
                    break; // success
                } catch (err) {
                    if (err instanceof ServerBusyError && busyIncreases < MAX_BUSY_INCREASES) {
                        busyIncreases++;
                        rateLimitMs += BUSY_INCREMENT_MS;
                        process.stderr.write(red(`\nMB server busy — increasing rate limit to ${rateLimitMs}ms (${busyIncreases}/${MAX_BUSY_INCREASES})\n`));
                    } else {
                        fatalError = new Error(`Fatal network error for "${bandName}": ${err.message}`);
                        break;
                    }
                }
            }
            if (fatalError) break;

            if (!albums.length) continue;

            const decision = computeBandUpdate(band, albums[0], TODAY, force);
            applyDecision(band, decision);

            if (decision.action === 'set_missing') {
                newAlbumsCount++;
                results.push({
                    bandName,
                    action: 'set_missing',
                    album: decision.set.missing,
                    releaseDate: albums[0]['first-release-date'],
                });
            }
        }
    } finally {
        bar.stop();
        try {
            await writeBands(bands);
        } catch (err) {
            console.error(red('Warning: failed to write checks.json:'), err.message);
        }
    }

    if (fatalError) {
        console.error(red(`\n${fatalError.message}`));
        process.exit(1);
    }

    const summary = buildSummary(results, Date.now() - startTime);
    console.log(summary);
    try {
        await writeFile(SUMMARY_FILE, stripAnsi(summary), 'utf8');
    } catch (err) {
        console.error(red('Warning: failed to write summary file:'), err.message);
    }
})();
