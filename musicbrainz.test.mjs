import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getReleaseGroups, ServerBusyError, _resetRateLimit } from './musicbrainz.mjs';

const FAST = { rateLimitMs: 0, retryDelays: [0, 0, 0] };

function makeResponse(groups, count) {
    return { ok: true, json: async () => ({ 'release-groups': groups, 'release-group-count': count }) };
}

function makeBusyResponse(msg = 'The MusicBrainz web server is currently busy. Please try again later.') {
    return { ok: false, status: 503, json: async () => ({ error: msg }) };
}

const makeGroup = (title, date, secondary = []) => ({
    title,
    'first-release-date': date,
    'secondary-types': secondary,
});

beforeEach(() => _resetRateLimit());

describe('getReleaseGroups', () => {
    it('returns filtered and sorted albums for a single page', async () => {
        const groups = [
            makeGroup('Album B', '2020-01-01'),
            makeGroup('Album A', '2022-01-01'),
            makeGroup('Live X', '2021-01-01', ['Live']),
        ];
        const mockFetch = mock.fn(async () => makeResponse(groups, 3));

        const result = await getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST });

        assert.equal(result.length, 2);              // Live filtered out
        assert.equal(result[0].title, 'Album A');    // newest first
        assert.equal(result[1].title, 'Album B');
        assert.equal(mockFetch.mock.calls.length, 1);
    });

    it('fetches all pages for multi-page artists', async () => {
        const mockFetch = mock.fn(async () => {
            const callIndex = mockFetch.mock.calls.length - 1;
            const group = callIndex === 0
                ? [makeGroup('Album A', '2022-01-01')]
                : [makeGroup('Album B', '2018-01-01')];
            return makeResponse(group, 150); // 150 total → 2 pages
        });

        const result = await getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST });

        assert.equal(mockFetch.mock.calls.length, 2);
        assert.equal(result.length, 2);
        assert.equal(result[0].title, 'Album A'); // newest first after merge
    });

    it('uses offset=0 for first page and offset=100 for second', async () => {
        const mockFetch = mock.fn(async (url) => {
            const group = [makeGroup(`Album`, `202${mockFetch.mock.calls.length}-01-01`)];
            return makeResponse(group, 150);
        });

        await getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST });

        const urls = mockFetch.mock.calls.map(c => c.arguments[0]);
        assert.ok(urls[0].includes('offset=0'), 'first call should use offset=0');
        assert.ok(urls[1].includes('offset=100'), 'second call should use offset=100');
    });

    it('returns empty array when no albums found', async () => {
        const mockFetch = mock.fn(async () => makeResponse([], 0));
        const result = await getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST });
        assert.deepEqual(result, []);
    });

    it('throws after 3 consecutive network failures', async () => {
        const mockFetch = mock.fn(async () => { throw new Error('ECONNREFUSED'); });

        await assert.rejects(
            () => getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST }),
            { message: 'ECONNREFUSED' }, // re-thrown directly, preserving the original error
        );
        assert.equal(mockFetch.mock.calls.length, 3);
    });

    it('retries on API-level rate-limit error responses (HTTP 200 with error body)', async () => {
        let callCount = 0;
        const mockFetch = mock.fn(async () => {
            callCount++;
            if (callCount < 3) {
                return { ok: true, json: async () => ({ error: 'Your requests are exceeding the allowable rate limit' }) };
            }
            return makeResponse([makeGroup('Album', '2020-01-01')], 1);
        });

        const result = await getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST });
        assert.equal(mockFetch.mock.calls.length, 3);
        assert.equal(result.length, 1);
    });

    it('normalizes year-only release dates', async () => {
        const mockFetch = mock.fn(async () =>
            makeResponse([makeGroup('Year Only', '2022')], 1),
        );

        const result = await getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST });
        assert.equal(result[0]['first-release-date'], '2022-01-01');
    });

    it('throws ServerBusyError for 503 responses with "busy" in the body', async () => {
        const mockFetch = mock.fn(async () => makeBusyResponse());

        await assert.rejects(
            () => getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST }),
            err => err instanceof ServerBusyError,
        );
        assert.equal(mockFetch.mock.calls.length, 3); // still retried 3 times first
    });

    it('throws ServerBusyError for 503 with a non-JSON body', async () => {
        const mockFetch = mock.fn(async () => ({
            ok: false,
            status: 503,
            json: async () => { throw new SyntaxError('Unexpected token'); },
        }));

        await assert.rejects(
            () => getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST }),
            err => err instanceof ServerBusyError,
        );
    });

    it('throws a plain Error (not ServerBusyError) for non-503 HTTP errors', async () => {
        const mockFetch = mock.fn(async () => ({
            ok: false,
            status: 404,
            json: async () => ({ error: 'Not Found' }),
        }));

        await assert.rejects(
            () => getReleaseGroups('TestBand', 'test-id', { fetchFn: mockFetch, ...FAST }),
            err => !(err instanceof ServerBusyError) && err instanceof Error,
        );
    });
});
