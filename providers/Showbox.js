'use strict';

/**
 * Nuvio ShowBox -> FebBox provider (direct-link mode).
 * Replaces the FEBAPI intermediary with ShowBox's public web search/share flow
 * and FebBox's own share/file endpoints. No video bytes are proxied by Nuvio.
 *
 * Required env: TMDB_API_KEY
 * Existing Nuvio call signature is intentionally preserved.
 */
const axios = require('axios');
const cheerio = require('cheerio');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const SHOWBOX_BASE = 'https://www.showbox.media';
const FEBBOX_BASE = 'https://www.febbox.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HTTP = axios.create({
    timeout: 18000,
    headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9'
    },
    maxRedirects: 5
});

const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

const normalizeToken = raw => clean(raw).replace(/^ui=/i, '');

const cookieHeader = raw => raw ? `ui=${normalizeToken(raw)}` : '';

const isHttpUrl = value => {
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
};

function parseQualityFromLabel(label) {
    const s = clean(label).toLowerCase();

    if (/2160|4k|uhd/.test(s)) return '2160p';
    if (/1080/.test(s)) return '1080p';
    if (/720/.test(s)) return '720p';
    if (/480/.test(s)) return '480p';
    if (/360/.test(s)) return '360p';
    if (/\bhd\b/.test(s)) return '720p';
    if (/\bsd\b/.test(s)) return '480p';

    return 'ORG';
}

function extractCodecDetails(text) {
    const s = clean(text).toLowerCase();
    const out = [];

    if (/dolby.?vision|dovi|\.dv\./.test(s)) out.push('DV');

    if (/hdr10\+|hdr10plus/.test(s)) {
        out.push('HDR10+');
    } else if (/hdr/.test(s)) {
        out.push('HDR');
    }

    if (/\bav1\b/.test(s)) out.push('AV1');
    else if (/h.?265|x265|hevc/.test(s)) out.push('H.265');
    else if (/h.?264|x264|avc/.test(s)) out.push('H.264');

    if (/atmos/.test(s)) out.push('Atmos');
    if (/true.?hd/.test(s)) out.push('TrueHD');

    if (/dts.?hd/.test(s)) out.push('DTS-HD');
    else if (/\bdts\b/.test(s)) out.push('DTS');

    if (/eac3|e-ac-3|dd\+|ddplus/.test(s)) out.push('EAC3');
    else if (/\bac3\b/.test(s)) out.push('AC3');

    if (/\baac\b/.test(s)) out.push('AAC');
    if (/\b10.?bit\b/.test(s)) out.push('10-bit');

    return [...new Set(out)];
}

function parseSizeToBytes(value) {
    const m = clean(value).match(/([\d.]+)\s*(tb|gb|mb|kb|b)/i);

    if (!m) return -1;

    const n = Number(m[1]);
    const unit = m[2].toLowerCase();

    const mult = {
        tb: 1024 ** 4,
        gb: 1024 ** 3,
        mb: 1024 ** 2,
        kb: 1024,
        b: 1
    }[unit];

    return Number.isFinite(n) ? n * mult : -1;
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

        if (q) return q;

        return parseSizeToBytes(b.size) - parseSizeToBytes(a.size);
    });
}

async function convertImdbToTmdb(imdbId, regionPreference = null, expectedType = null) {
    if (!/^tt\d+$/i.test(clean(imdbId)) || !TMDB_API_KEY) {
        return null;
    }

    try {
        const { data } = await HTTP.get(
            `${TMDB_BASE}/find/${encodeURIComponent(imdbId)}`,
            {
                params: {
                    api_key: TMDB_API_KEY,
                    external_source: 'imdb_id'
                },
                timeout: 12000
            }
        );

        const wantTv = expectedType === 'tv' || expectedType === 'series';

        const list = wantTv
            ? [...(data.tv_results || []), ...(data.movie_results || [])]
            : [...(data.movie_results || []), ...(data.tv_results || [])];

        if (!list.length) return null;

        const item = list[0];

        const isTv =
            !!(data.tv_results || []).find(x => String(x.id) === String(item.id)) &&
            (wantTv || !(data.movie_results || []).length);

        return {
            tmdbId: String(item.id),
            tmdbType: isTv ? 'tv' : 'movie',
            title: item.name || item.title || item.original_name || item.original_title
        };
    } catch (e) {
        console.warn('[ShowBox] IMDb-to-TMDB lookup failed:', e.message);
        return null;
    }
}

async function getTmdbInfo(type, id) {
    if (!TMDB_API_KEY) {
        throw new Error('TMDB_API_KEY is not configured in Render');
    }

    const kind = type === 'tv' || type === 'series' ? 'tv' : 'movie';

    const { data } = await HTTP.get(
        `${TMDB_BASE}/${kind}/${encodeURIComponent(id)}`,
        {
            params: { api_key: TMDB_API_KEY },
            timeout: 12000
        }
    );

    const title = data.title || data.name || data.original_title || data.original_name;

    const yearText = data.release_date || data.first_air_date || '';
    const year = yearText ? yearText.slice(0, 4) : '';

    const aliases = [];

    try {
        const { data: alt } = await HTTP.get(
            `${TMDB_BASE}/${kind}/${encodeURIComponent(id)}/alternative_titles`,
            {
                params: { api_key: TMDB_API_KEY },
                timeout: 10000
            }
        );

        for (const x of (alt.titles || alt.results || [])) {
            if (x.title || x.name) aliases.push(x.title || x.name);
        }
    } catch (_) {
        // Alternative titles are optional.
    }

    return {
        kind,
        title,
        year,
        aliases: [...new Set(aliases)].filter(Boolean)
    };
}

function similarity(a, b) {
    const norm = s => clean(s)
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const aa = norm(a);
    const bb = norm(b);

    if (!aa || !bb) return 0;
    if (aa === bb) return 1;

    const A = aa.split(' ');
    const B = bb.split(' ');

    const overlap = A.filter(w => B.includes(w)).length;
    const dice = (2 * overlap) / (A.length + B.length);
    const prefix = aa.includes(bb) || bb.includes(aa) ? 0.15 : 0;

    return Math.min(1, dice + prefix);
}

async function searchShowbox(title, kind) {
    const { data: html } = await HTTP.get(
        `${SHOWBOX_BASE}/search`,
        {
            params: { keyword: title },
            timeout: 18000
        }
    );

    const $ = cheerio.load(html);
    const candidates = [];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';

        const match = href.match(
            /\/(movie|tv)\/([mt]-[^/?#]+?)(?:-(\d{4}))?(?:[/?#]|$)/i
        );

        if (!match) return;

        const mediaKind = match[1].toLowerCase();

        const name = clean(
            $(el).attr('title') ||
            $(el).text() ||
            $(el).find('img').attr('alt')
        );

        if (!name) return;

        const path = href.startsWith('http')
            ? new URL(href).pathname
            : href;

        candidates.push({
            path,
            name,
            year: match[3] || '',
            kind: mediaKind
        });
    });

    const unique = new Map();

    for (const c of candidates) {
        if (!unique.has(c.path)) unique.set(c.path, c);
    }

    return [...unique.values()].filter(c => c.kind === kind);
}

async function getShareKeyFromShowboxPath(path) {
    const detailUrl = new URL(path, SHOWBOX_BASE).toString();

    const { data: html } = await HTTP.get(detailUrl, {
        timeout: 18000
    });

    const $ = cheerio.load(html);
    let id = null;
    let type = null;

    const source = String(html);

    const patterns = [
        /(?:url|src)\s*[:=]\s*["'][^"']*\/index\/share_link\?id=(\d+)(?:&amp;|&)type=(\d+)/i,
        /\/index\/share_link\?id=(\d+)(?:&amp;|&)type=(\d+)/i,
        /share_link[^\n]{0,180}?id["'=:\s]+(\d+)[^\n]{0,100}?type["'=:\s]+(\d+)/i
    ];

    for (const re of patterns) {
        const m = source.match(re);

        if (m) {
            id = m[1];
            type = m[2];
            break;
        }
    }

    if (!id) {
        $('[data-id]').each((_, el) => {
            if (!id) id = $(el).attr('data-id');
        });

        $('[data-type]').each((_, el) => {
            if (!type) type = $(el).attr('data-type');
        });
    }

    if (!id || !type) return null;

    const { data } = await HTTP.get(
        `${SHOWBOX_BASE}/index/share_link`,
        {
            params: { id, type },
            timeout: 15000,
            headers: { Referer: detailUrl }
        }
    );

    const link = data && data.data && data.data.link;

    if (Number(data && data.code) !== 1 || !link) {
        return null;
    }

    const parts = String(link).match(
        /(?:share\/)?([A-Za-z0-9_-]{5,})(?:\/?$)/
    );

    return parts ? parts[1] : null;
}

function findArrayDeep(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) {
        return [];
    }

    for (const key of keys) {
        if (Array.isArray(obj[key])) return obj[key];
    }

    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
            const found = findArrayDeep(value, keys, depth + 1);

            if (found.length) return found;
        }
    }

    return [];
}

async function listShareFiles(shareKey, cookie, parentId = '0', page = 1) {
    const headers = {
        Referer: `${FEBBOX_BASE}/share/${shareKey}`
    };

    if (cookie) {
        headers.Cookie = cookieHeader(cookie);
    }

    const { data } = await HTTP.get(
        `${FEBBOX_BASE}/file/file_share_list`,
        {
            params: {
                share_key: shareKey,
                parent_id: parentId,
                page,
                pagelimit: 100
            },
            headers,
            timeout: 18000
        }
    );

    const files = findArrayDeep(
        data,
        ['file_list', 'files', 'list', 'data']
    );

    return files.filter(x => x && typeof x === 'object');
}

function fileNameOf(file) {
    return clean(
        file.file_name ||
        file.filename ||
        file.name ||
        file.title
    );
}

function fileIdOf(file) {
    return file.fid || file.file_id || file.id;
}

function isFolder(file) {
    return Number(
        file.is_dir ||
        file.is_folder ||
        file.folder ||
        file.file_type === 'folder'
    ) === 1 || file.is_dir === true || file.is_folder === true;
}

function episodeMatch(filename, season, episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');

    const patterns = [
        new RegExp(`S${s}E${e}(?!\\d)`, 'i'),
        new RegExp(`S${season}\\s*E${episode}(?!\\d)`, 'i'),
        new RegExp(`Season\\s*${season}.*Episode\\s*${episode}`, 'i'),
        new RegExp(`\\b${season}x${e}\\b`, 'i')
    ];

    return patterns.some(re => re.test(filename));
}

async function collectVideoFiles(
    shareKey,
    cookie,
    parentId = '0',
    depth = 0,
    out = []
) {
    if (depth > 4 || out.length >= 250) return out;

    let files = [];

    try {
        files = await listShareFiles(shareKey, cookie, parentId, 1);
    } catch (e) {
        console.warn(
            '[ShowBox] FebBox share listing failed:',
            e.response ? e.response.status : e.message
        );

        return out;
    }

    for (const file of files) {
        const id = fileIdOf(file);

        if (!id) continue;

        if (isFolder(file)) {
            await collectVideoFiles(
                shareKey,
                cookie,
                String(id),
                depth + 1,
                out
            );
        } else if (/\.(mkv|mp4|avi|mov|m4v|webm)$/i.test(fileNameOf(file))) {
            out.push(file);
        }

        if (out.length >= 250) break;
    }

    return out;
}

async function getDirectLinks(shareKey, file, cookie) {
    const fid = fileIdOf(file);

    if (!fid) return [];

    const headers = {
        Referer: `${FEBBOX_BASE}/share/${shareKey}`
    };

    if (cookie) {
        headers.Cookie = cookieHeader(cookie);
    }

    const { data: html } = await HTTP.get(
        `${FEBBOX_BASE}/console/video_quality_list`,
        {
            params: { fid },
            headers,
            timeout: 18000
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

        if (
            url &&
            isHttpUrl(url) &&
            !/\.m3u8(?:$|\?)/i.test(url)
        ) {
            links.push({ url, label });
        }
    });

    if (!links.length) {
        $('a[href]').each((_, el) => {
            const url = $(el).attr('href') || '';

            const label = clean(
                $(el).text() || $(el).attr('title')
            );

            if (
                isHttpUrl(url) &&
                !/\.m3u8(?:$|\?)/i.test(url) &&
                /\b(2160|1080|720|480|360|org|original)\b/i.test(label)
            ) {
                links.push({ url, label });
            }
        });
    }

    return links;
}

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

        const info = await getTmdbInfo(kind, tmdbId);

        if (!info.title) return [];

        let cookieList =
            typeof cookies === 'string'
                ? [cookies]
                : Array.isArray(cookies)
                    ? cookies
                    : [];

        cookieList = cookieList.map(normalizeToken).filter(Boolean);

        let selectedCookie = cookieList[0] || null;

        if (cookieList.length > 1) {
            const checks = await Promise.all(
                cookieList.map(async token => {
                    try {
                        const { data } = await HTTP.get(
                            `${FEBBOX_BASE}/console/user_cards`,
                            {
                                headers: {
                                    Cookie: cookieHeader(token)
                                },
                                timeout: 8000
                            }
                        );

                        const flow = data && data.data && data.data.flow;

                        return {
                            token,
                            remaining: flow
                                ? (Number(flow.traffic_limit_mb) || 0) -
                                  (Number(flow.traffic_usage_mb) || 0)
                                : -1
                        };
                    } catch (_) {
                        return { token, remaining: -1 };
                    }
                })
            );

            checks.sort((a, b) => b.remaining - a.remaining);

            selectedCookie = checks[0].token;
        }

        const queries = [info.title, ...info.aliases]
            .filter(Boolean)
            .slice(0, 4);

        let ranked = [];

        for (const query of queries) {
            try {
                const found = await searchShowbox(query, kind);

                for (const c of found) {
                    const score = Math.max(
                        similarity(info.title, c.name),
                        ...info.aliases.map(a => similarity(a, c.name)),
                        0
                    );

                    const yearPenalty =
                        info.year &&
                        c.year &&
                        Math.abs(Number(info.year) - Number(c.year)) > 1
                            ? 0.3
                            : 0;

                    ranked.push({
                        ...c,
                        score:
                            score -
                            yearPenalty +
                            (info.year && c.year === info.year ? 0.12 : 0)
                    });
                }
            } catch (e) {
                console.warn('[ShowBox] ShowBox search failed:', e.message);
            }

            if (ranked.some(x => x.score >= 0.72)) break;
        }

        ranked.sort((a, b) => b.score - a.score);

        const candidate = ranked.find(x => x.score >= 0.72);

        if (!candidate) {
            console.log(
                `[ShowBox] No confident ShowBox match for ${info.title}`
            );

            return [];
        }

        const shareKey = await getShareKeyFromShowboxPath(candidate.path);

        if (!shareKey) {
            console.log('[ShowBox] Could not obtain a FebBox share key');
            return [];
        }

        const { data: sharePage } = await HTTP.get(
            `${FEBBOX_BASE}/share/${shareKey}`,
            {
                timeout: 15000,
                headers: selectedCookie
                    ? { Cookie: cookieHeader(selectedCookie) }
                    : {}
            }
        );

        if (
            typeof sharePage === 'string' &&
            /share (?:not found|expired)|文件不存在|分享已失效/i.test(sharePage)
        ) {
            return [];
        }

        let files = await collectVideoFiles(
            shareKey,
            selectedCookie
        );

        if (kind === 'tv') {
            files = files.filter(file =>
                episodeMatch(
                    fileNameOf(file),
                    seasonNum,
                    episodeNum
                )
            );
        }

        if (!files.length) return [];

        const streams = [];

        for (const file of files.slice(0, 12)) {
            const name = fileNameOf(file);

            let links = [];

            try {
                links = await getDirectLinks(
                    shareKey,
                    file,
                    selectedCookie
                );
            } catch (e) {
                console.warn(
                    '[ShowBox] Direct-link extraction failed:',
                    e.response ? e.response.status : e.message
                );
            }

            for (const link of links) {
                streams.push({
                    name: 'ShowBox',
                    title: `${parseQualityFromLabel(link.label || name)} · ${name}`,
                    url: link.url,
                    quality: parseQualityFromLabel(link.label || name),
                    codecs: extractCodecDetails(`${name} ${link.label}`),
                    size: file.file_size || file.size || 'Unknown',
                    provider: 'ShowBox'
                });
            }
        }

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
    parseQualityFromLabel
};
