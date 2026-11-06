'use strict';

/**
 * Nuvio ShowBox -> FebBox provider
 * Uses ShowBox public HTML discovery and FebBox direct playback.
 * No FebAPI intermediary and no video proxying.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB = 'https://api.themoviedb.org/3';
const SHOWBOX = 'https://www.showbox.media';
const FEBBOX = 'https://www.febbox.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const http = axios.create({
    timeout: 18000,
    headers: { 'User-Agent': UA }
});

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();

function normalizeCookie(value) {
    return clean(value).replace(/^ui=/i, '');
}

function cookieHeader(value) {
    const token = normalizeCookie(value);
    return token ? `ui=${token}` : '';
}

function parseQuality(label) {
    const s = clean(label).toLowerCase();

    if (/2160|4k|uhd/.test(s)) return '2160p';
    if (/1080/.test(s)) return '1080p';
    if (/720/.test(s)) return '720p';
    if (/480/.test(s)) return '480p';
    if (/360/.test(s)) return '360p';

    return 'ORG';
}

function parseSize(value) {
    const m = clean(value).match(/([\d.]+)\s*(tb|gb|mb|kb|b)/i);
    if (!m) return -1;

    const factors = {
        tb: 1024 ** 4,
        gb: 1024 ** 3,
        mb: 1024 ** 2,
        kb: 1024,
        b: 1
    };

    return Number(m[1]) * factors[m[2].toLowerCase()];
}

function extractCodecs(value) {
    const s = clean(value).toLowerCase();
    const result = [];

    if (/dolby.?vision|dovi/.test(s)) result.push('DV');
    if (/hdr10\+/.test(s)) result.push('HDR10+');
    else if (/hdr/.test(s)) result.push('HDR');

    if (/x265|h.?265|hevc/.test(s)) result.push('H.265');
    else if (/x264|h.?264|avc/.test(s)) result.push('H.264');

    if (/atmos/.test(s)) result.push('Atmos');
    if (/true.?hd/.test(s)) result.push('TrueHD');
    if (/dts.?hd/.test(s)) result.push('DTS-HD');
    else if (/\bdts\b/.test(s)) result.push('DTS');

    if (/eac3|e-ac-3|dd\+/.test(s)) result.push('EAC3');
    else if (/\bac3\b/.test(s)) result.push('AC3');

    if (/\baac\b/.test(s)) result.push('AAC');

    return [...new Set(result)];
}

function sortStreamsByQuality(streams) {
    const rank = {
        ORG: 1,
        '2160p': 2,
        '1080p': 3,
        '720p': 4,
        '480p': 5,
        '360p': 6
    };

    return [...(Array.isArray(streams) ? streams : [])].sort((a, b) => {
        const q = (rank[a.quality] || 10) - (rank[b.quality] || 10);
        return q || parseSize(b.size) - parseSize(a.size);
    });
}

/* ---------------- TMDB ---------------- */

async function convertImdbToTmdb(imdbId, regionPreference = null, expectedType = null) {
    if (!TMDB_KEY || !/^tt\d+$/i.test(clean(imdbId))) return null;

    try {
        const { data } = await http.get(`${TMDB}/find/${imdbId}`, {
            params: {
                api_key: TMDB_KEY,
                external_source: 'imdb_id'
            }
        });

        const wantTv = expectedType === 'tv' || expectedType === 'series';

        const list = wantTv
            ? [...(data.tv_results || []), ...(data.movie_results || [])]
            : [...(data.movie_results || []), ...(data.tv_results || [])];

        if (!list.length) return null;

        const item = list[0];
        const isTv = (data.tv_results || []).some(x => String(x.id) === String(item.id));

        return {
            tmdbId: String(item.id),
            tmdbType: isTv ? 'tv' : 'movie',
            title: item.name || item.title
        };
    } catch (e) {
        console.warn('[ShowBox] TMDB IMDb lookup failed:', e.message);
        return null;
    }
}

async function getTmdbInfo(kind, id) {
    if (!TMDB_KEY) throw new Error('TMDB_API_KEY missing');

    const { data } = await http.get(`${TMDB}/${kind}/${id}`, {
        params: { api_key: TMDB_KEY }
    });

    const title = data.title || data.name || '';
    const date = data.release_date || data.first_air_date || '';

    const altTitles = [];

    try {
        const { data: alt } = await http.get(
            `${TMDB}/${kind}/${id}/alternative_titles`,
            { params: { api_key: TMDB_KEY } }
        );

        for (const item of (alt.titles || alt.results || [])) {
            if (item.title || item.name) {
                altTitles.push(item.title || item.name);
            }
        }
    } catch (_) {}

    return {
        title,
        year: date ? Number(date.slice(0, 4)) : null,
        altTitles: [...new Set(altTitles)]
    };
}

/* ---------------- ShowBox catalog ---------------- */

function normalizeTitle(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleSimilarity(a, b) {
    const A = normalizeTitle(a);
    const B = normalizeTitle(b);

    if (!A || !B) return 0;
    if (A === B) return 1;

    const aa = A.split(' ');
    const bb = B.split(' ');

    const common = aa.filter(x => bb.includes(x)).length;

    return (2 * common) / (aa.length + bb.length);
}

function computeMatchScore(candidate, target) {
    let score = titleSimilarity(candidate.title, target.title);

    if (candidate.year && target.year) {
        const diff = Math.abs(candidate.year - target.year);

        if (diff === 0) score += 0.15;
        else if (diff === 1) score -= 0.05;
        else score -= 0.35;
    }

    return score;
}

async function searchShowbox(title, kind) {
    const { data: html, status } = await http.get(`${SHOWBOX}/search`, {
        params: { keyword: title },
        validateStatus: () => true
    });

    if (status !== 200 || typeof html !== 'string') return [];

    const $ = cheerio.load(html);
    const results = [];

    $('a[href^="/movie/"], a[href^="/tv/"]').each((_, el) => {
        const href = $(el).attr('href') || '';

        // Exact URL structure from the working FebBox catalog.js
        const match = href.match(
            /^\/(movie|tv)\/(m|t)-(.+?)-(\d{4})$/
        );

        if (!match) return;

        const [, mediaType, , slug, year] = match;

        if (mediaType !== kind) return;
        if (results.some(x => x.path === href)) return;

        results.push({
            title: slug.replace(/-/g, ' '),
            year: Number(year),
            path: href,
            kind: mediaType
        });
    });

    return results;
}

/**
 * Exact ShowBox detail-page extraction from the supplied working catalog.js.
 */
async function getShowboxIdAndType(path) {
    const { data: html, status } = await http.get(
        `${SHOWBOX}${path}`,
        { validateStatus: () => true }
    );

    if (status !== 200 || typeof html !== 'string') return null;

    const match = html.match(
        /url:\s*'\/index\/share_link'[\s\S]{0,120}?data:\s*\{\s*'id':\s*(\d+)\s*,\s*'type':\s*(\d)\s*\}/
    );

    if (!match) {
        console.warn('[ShowBox] Share-link ID/type not found in detail page');
        return null;
    }

    return {
        showboxId: match[1],
        boxType: Number(match[2])
    };
}

/**
 * Exact ShowBox share-link endpoint and response validation
 * from the supplied working catalog.js.
 */
async function getFebBoxShareKey(showboxId, boxType) {
    const { data, status } = await http.get(
        `${SHOWBOX}/index/share_link`,
        {
            params: {
                id: showboxId,
                type: boxType
            },
            headers: {
                'X-Requested-With': 'XMLHttpRequest'
            },
            validateStatus: () => true
        }
    );

    if (status !== 200 || !data || data.code !== 1) return null;

    const link = data.data && data.data.link;

    if (!link || typeof link !== 'string') return null;

    return link.split('/').filter(Boolean).pop() || null;
}

async function resolveShareKey(info, kind) {
    const queries = [info.title, ...(info.altTitles || [])];

    for (const query of queries) {
        let results = [];

        try {
            results = await searchShowbox(query, kind);
        } catch (e) {
            console.warn('[ShowBox] Search error:', e.message);
            continue;
        }

        const ranked = results
            .map(candidate => ({
                candidate,
                score: computeMatchScore(candidate, {
                    title: query,
                    year: info.year
                })
            }))
            .filter(x => x.score >= 0.72)
            .sort((a, b) => b.score - a.score);

        for (const { candidate } of ranked) {
            try {
                const idInfo = await getShowboxIdAndType(candidate.path);
                if (!idInfo) continue;

                const shareKey = await getFebBoxShareKey(
                    idInfo.showboxId,
                    idInfo.boxType
                );

                if (!shareKey) continue;

                // Check that the public share page exists.
                const check = await http.get(
                    `${FEBBOX}/share/${encodeURIComponent(shareKey)}`,
                    { validateStatus: () => true, timeout: 10000 }
                );

                if (check.status === 200) return shareKey;
            } catch (e) {
                console.warn('[ShowBox] Candidate resolution error:', e.message);
            }
        }
    }

    return null;
}

/* ---------------- FebBox file listing ---------------- */

function findFileArray(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return [];

    for (const key of ['file_list', 'files', 'list']) {
        if (Array.isArray(obj[key])) return obj[key];
    }

    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
            const found = findFileArray(value, depth + 1);
            if (found.length) return found;
        }
    }

    return [];
}

async function listShareFiles(shareKey, token, parentId = '0') {
    const headers = {
        Referer: `${FEBBOX}/share/${shareKey}`
    };

    if (token) headers.Cookie = cookieHeader(token);

    const { data } = await http.get(`${FEBBOX}/file/file_share_list`, {
        params: {
            share_key: shareKey,
            parent_id: parentId,
            page: 1,
            pagelimit: 100
        },
        headers
    });

    return findFileArray(data);
}

function fileName(file) {
    return clean(
        file.file_name ||
        file.filename ||
        file.name ||
        file.title
    );
}

function fileId(file) {
    return file.fid || file.file_id || file.id;
}

function isFolder(file) {
    return file.is_dir === true ||
        file.is_folder === true ||
        Number(file.is_dir) === 1 ||
        Number(file.is_folder) === 1 ||
        file.file_type === 'folder';
}

async function collectFiles(shareKey, token, parentId = '0', depth = 0, output = []) {
    if (depth > 4 || output.length >= 250) return output;

    let files;

    try {
        files = await listShareFiles(shareKey, token, parentId);
    } catch (e) {
        console.warn('[ShowBox] FebBox file-list error:', e.message);
        return output;
    }

    for (const file of files) {
        const id = fileId(file);
        if (!id) continue;

        if (isFolder(file)) {
            await collectFiles(shareKey, token, String(id), depth + 1, output);
        } else if (/\.(mkv|mp4|avi|mov|m4v|webm)$/i.test(fileName(file))) {
            output.push(file);
        }

        if (output.length >= 250) break;
    }

    return output;
}

/* ---------------- Episode matching ---------------- */

function matchesEpisode(filename, season, episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');

    return [
        new RegExp(`S${s}E${e}(?!\\d)`, 'i'),
        new RegExp(`S${season}\\s*E${episode}(?!\\d)`, 'i'),
        new RegExp(`\\b${season}x${e}\\b`, 'i'),
        new RegExp(`Season\\s*${season}.*Episode\\s*${episode}`, 'i')
    ].some(re => re.test(filename));
}

/* ---------------- FebBox direct playback ---------------- */

async function getDirectLinks(shareKey, file, token) {
    const fid = fileId(file);
    if (!fid) return [];

    const headers = {
        Referer: `${FEBBOX}/share/${shareKey}`
    };

    if (token) headers.Cookie = cookieHeader(token);

    const { data: html } = await http.get(
        `${FEBBOX}/console/video_quality_list`,
        {
            params: { fid },
            headers
        }
    );

    const $ = cheerio.load(
        typeof html === 'string' ? html : JSON.stringify(html)
    );

    const links = [];

    $('.file_quality').each((_, el) => {
        const node = $(el);

        const url =
            node.attr('data-url') ||
            node.find('[data-url]').attr('data-url') ||
            node.find('a[href]').attr('href');

        const label = clean(
            node.attr('data-quality') ||
            node.attr('title') ||
            node.text()
        );

        if (!url || !/^https?:\/\//i.test(url)) return;
        if (/\.m3u8(?:$|\?)/i.test(url)) return;

        // Direct original file only; exclude transcoded HLS.
        if (/2160|1080|720|480|360|hls/i.test(label)) return;

        links.push({ url, label: 'ORG' });
    });

    return links;
}

/* ---------------- Main Nuvio provider function ---------------- */

async function getStreamsFromTmdbId(
    tmdbType,
    tmdbId,
    seasonNum = null,
    episodeNum = null,
    regionPreference = null,
    cookies = null,
    userScraperApiKey = null
) {
    try {
        const kind =
            tmdbType === 'tv' || tmdbType === 'series'
                ? 'tv'
                : tmdbType === 'movie'
                    ? 'movie'
                    : null;

        if (!kind || !tmdbId) return [];

        if (kind === 'tv' && (seasonNum == null || episodeNum == null)) {
            return [];
        }

        console.log(`[ShowBox] Looking up TMDB ${kind}/${tmdbId}`);

        const info = await getTmdbInfo(kind, tmdbId);
        if (!info.title) return [];

        // Accept the cookie string or cookie array passed by Nuvio.
        const cookieList = (
            typeof cookies === 'string'
                ? [cookies]
                : Array.isArray(cookies)
                    ? cookies
                    : []
        ).map(normalizeCookie).filter(Boolean);

        let selectedCookie = cookieList[0] || null;

        // Select the cookie with the most remaining FebBox quota.
        if (cookieList.length > 1) {
            const checks = await Promise.all(cookieList.map(async token => {
                try {
                    const { data } = await http.get(
                        `${FEBBOX}/console/user_cards`,
                        {
                            headers: { Cookie: cookieHeader(token) },
                            timeout: 8000
                        }
                    );

                    const flow = data && data.data && data.data.flow;

                    const remaining = flow
                        ? (Number(flow.traffic_limit_mb) || 0) -
                          (Number(flow.traffic_usage_mb) || 0)
                        : -1;

                    return { token, remaining };
                } catch (_) {
                    return { token, remaining: -1 };
                }
            }));

            checks.sort((a, b) => b.remaining - a.remaining);
            selectedCookie = checks[0].token;
        }

        console.log(`[ShowBox] Searching ShowBox for "${info.title}"`);

        const shareKey = await resolveShareKey(info, kind);

        if (!shareKey) {
            console.warn('[ShowBox] Could not obtain a FebBox share key');
            return [];
        }

        console.log('[ShowBox] Share key resolved successfully');

        const files = await collectFiles(shareKey, selectedCookie);

        const selectedFiles = kind === 'tv'
            ? files.filter(file =>
                matchesEpisode(fileName(file), seasonNum, episodeNum)
            )
            : files;

        if (!selectedFiles.length) {
            console.log('[ShowBox] No matching video files found');
            return [];
        }

        const streams = [];

        for (const file of selectedFiles.slice(0, 12)) {
            try {
                const links = await getDirectLinks(
                    shareKey,
                    file,
                    selectedCookie
                );

                for (const link of links) {
                    const name = fileName(file);

                    streams.push({
                        name: 'ShowBox',
                        title: `FebBox ORG · ${name}`,
                        url: link.url,
                        quality: 'ORG',
                        size: file.file_size || file.size || 'Unknown',
                        codecs: extractCodecs(name),
                        provider: 'ShowBox'
                    });
                }
            } catch (e) {
                console.warn('[ShowBox] Direct link error:', e.message);
            }
        }

        console.log(`[ShowBox] Returning ${streams.length} direct streams`);

        return sortStreamsByQuality(streams);

    } catch (e) {
        console.error(
            '[ShowBox] Provider error:',
            e.response ? `HTTP ${e.response.status}` : e.message
        );

        return [];
    }
}

module.exports = {
    getStreamsFromTmdbId,
    convertImdbToTmdb,
    sortStreamsByQuality,
    parseQualityFromLabel: parseQuality
};
