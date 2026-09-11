import { readFile } from 'fs/promises';
import process from 'node:process'

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function getReleaseGroups(bandName, musicbrainz_id) {
    const API_ROOT_URL = 'https://musicbrainz.org/ws/2';
    let offset = 0;
    let pagesLeft = 1;
    let pagesLeftCalculated = false;
    let albumRecords = [];

    do {
        const params = new URLSearchParams();
        params.append("artist", musicbrainz_id);
        params.append("type", 'album');
        params.append("limit", "100")
        params.append("offset", offset.toString())
        const response = await fetch(
            `${API_ROOT_URL}/release-group?${params}`,
            {
                headers: new Headers({
                    "Accept"       : "application/json",
                    "Content-Type" : "application/json",
                    "User-Agent"   : "MyMusic/1.0 https://github.com/chrisvoo/discography"
                })
            }
        )
        const data = await response.json();
        if (data.error && data.error.toString().startsWith('Your requests are exceeding the allowable rate limit')) {
            console.log('rate limit exceeded');
            await sleep(1000);
            return [];
        }

        let tempAlbumRecords = data['release-groups'];

        if (!tempAlbumRecords || !tempAlbumRecords.length) {
            console.warn(`No albums found for ${bandName}`);
            console.log(`${API_ROOT_URL}/release-group?${params}`)
            await sleep(1000);
            return [];
        }

        albumRecords = albumRecords.concat(tempAlbumRecords);

        if (!pagesLeftCalculated) {
            const totalRecords = +data['release-group-count']
            if (totalRecords > 100) {
                pagesLeft = Math.ceil(totalRecords / 100) - 1
            }
        }
        offset += 100;
        await sleep(1000);
    } while (pagesLeft === 0)

    albumRecords = albumRecords
        .filter(item =>
            !Object.hasOwn(item, 'secondary-types') ||
            (
                !item['secondary-types'].includes('Compilation') &&
                !item['secondary-types'].includes('Live') &&
                !item['secondary-types'].includes('Soundtrack')
            )
        )
        .map(item => {
            if (Object.hasOwn(item, 'first-release-date') && item['first-release-date'].toString().length === 4) {
                item['first-release-date'] = `${item['first-release-date']}-01-01`;
            }
            return item;
        });

    albumRecords.sort(
        (a, b) => a['first-release-date'] < b['first-release-date']
            ? 1
            : ((a['first-release-date'] > b['first-release-date']) ? -1 : 0 )
    );

    return albumRecords
}

(async () => {

    const CURRENT_DATE_CHECK = new Date().toJSON().slice(0,10);

    try {
        const data = await readFile('./checks.json',{ encoding: 'utf8' });
        const bands = JSON.parse(data);

        for (const [bandName, bandInfo] of Object.entries(bands)) {
            const { last_album, musicbrainz_id, exclude } = bandInfo;

            const albumRecords = await getReleaseGroups(bandName, musicbrainz_id);

            if (!albumRecords.length) {
                continue;
            }

            if (
                albumRecords[0].title.toLowerCase() === last_album.toLowerCase() ||
                (Array.isArray(exclude) && exclude.includes(albumRecords[0].title))
            ) {
                bands[bandName].last_check = CURRENT_DATE_CHECK;
                await sleep(1000);
                continue;
            }

            bands[bandName].last_album = albumRecords[0].title;
            bands[bandName].last_album_release_date = albumRecords[0]['first-release-date'];
            bands[bandName].last_check = CURRENT_DATE_CHECK;

            console.log(`- ${bandName} album found: ${albumRecords[0].title} (${albumRecords[0]['first-release-date']}) (we have ${last_album.toLowerCase()} / https://musicbrainz.org/artist/${musicbrainz_id})`)
            // console.log(albumRecords.map(i => ({
            //     title: i.title,
            //     date: i['first-release-date'],
            //     sec_type: i['secondary-type'] ?? 'n/a',
            // })))

            await sleep(1000);
        }
    } catch (err) {
        console.log(err);
    }
})();