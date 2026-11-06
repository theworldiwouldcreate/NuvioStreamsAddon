 require('dotenv').config();
const axios = require('axios');

// TMDB API Configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// API Base URL
const FEBAPI_BASE_URL = 'https://febapi.nuvioapp.space/api/media';

/**
 * Parse quality from label string
 */
const parseQualityFromLabel = (label) => {
    if (!label) return "ORG";

    const labelLower = String(label).toLowerCase();

    if (labelLower.includes('1080p') || labelLower.includes('1080')) {
        return "1080p";
    } else if (labelLower.includes('720p') || labelLower.includes('720')) {
        return "720p";
    } else if (labelLower.includes('480p') || labelLower.includes('480')) {
        return "480p";
    } else if (labelLower.includes('360p') || labelLower.includes('360')) {
        return "360p";
    } else if (labelLower.includes('2160p') || labelLower.includes('2160') ||
        labelLower.includes('4k') || labelLower.includes('uhd')) {
        return "2160p";
    } else if (labelLower.includes('hd')) {
        return "720p";
    } else if (labelLower.includes('sd')) {
        return "480p";
    }

    return "ORG";
};

/**
 * Extract codec details from filename/text
 */
const extractCodecDetails = (text) => {
    if (!text || typeof text !== 'string') return [];
    const details = new Set();
    const lowerText = text.toLowerCase();

    if (lowerText.includes('dolby vision') || lowerText.includes('dovi') || lowerText.includes('.dv.')) details.add('DV');
    if (lowerText.includes('hdr10+') || lowerText.includes('hdr10plus')) details.add('HDR10+');
    else if (lowerText.includes('hdr')) details.add('HDR');
    if (lowerText.includes('sdr')) details.add('SDR');

    if (lowerText.includes('av1')) details.add('AV1');
    else if (lowerText.includes('h265') || lowerText.includes('x265') || lowerText.includes('hevc')) details.add('H.265');
    else if (lowerText.includes('h264') || lowerText.includes('x264') || lowerText.includes('avc')) details.add('H.264');

    if (lowerText.includes('atmos')) details.add('Atmos');
    if (lowerText.includes('truehd') || lowerText.includes('true-hd')) details.add('TrueHD');
    if (lowerText.includes('dts-hd ma') || lowerText.includes('dtshdma') || lowerText.includes('dts-hdhr')) details.add('DTS-HD MA');
    else if (lowerText.includes('dts-hd')) details.add('DTS-HD');
    else if (lowerText.includes('dts') && !lowerText.includes('dts-hd')) details.add('DTS');

    if (lowerText.includes('eac3') || lowerText.includes('e-ac-3') || lowerText.includes('dd+') || lowerText.includes('ddplus')) details.add('EAC3');
    else if (lowerText.includes('ac3') || (lowerText.includes('dd') && !lowerText.includes('dd+') && !lowerText.includes('ddp'))) details.add('AC3');

    if (lowerText.includes('aac')) details.add('AAC');
    if (lowerText.includes('opus')) details.add('Opus');
    if (lowerText.includes('mp3')) details.add('MP3');

    if (lowerText.includes('10bit') || lowerText.includes('10-bit')) details.add('10-bit');
    else if (lowerText.includes('8bit') || lowerText.includes('8-bit')) details.add('8-bit');

    return Array.from(details);
};

/**
 * Helper function to parse size string to bytes
 */
const parseSizeToBytes = (sizeString) => {
    if (!sizeString || typeof sizeString !== 'string') return Number.MAX_SAFE_INTEGER;

    const sizeLower = sizeString.toLowerCase();

    if (sizeLower.includes('unknown') || sizeLower.includes('n/a')) {
        return Number.MAX_SAFE_INTEGER;
    }

    const units = {
        gb: 1024 * 1024 * 1024,
        mb: 1024 * 1024,
        kb: 1024,
        b: 1
    };

    const match = sizeString.match(/([\d.]+)\s*(gb|mb|kb|b)/i);
    if (match && match[1] && match[2]) {
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (!isNaN(value) && units[unit]) {
            return Math.floor(value * units[unit]);
        }
    }
    return Number.MAX_SAFE_INTEGER;
};

/**
 * Utility function to sort streams by quality
 */
const sortStreamsByQuality = (streams) => {
    const qualityOrder = {
        "ORG": 1,
        "2160p": 2,
        "1080p": 3,
        "720p": 4,
        "480p": 5,
        "360p": 6
    };

    const providerSortKeys = {
        'ShowBox': 1,
        'Xprime.tv': 2,
        'HollyMovieHD': 3,
        'Soaper TV': 4,
        default: 99
    };

    return [...streams].sort((a, b) => {
        const qualityA = a.quality || "ORG";
        const qualityB = b.quality || "ORG";

        const orderA = qualityOrder[qualityA] || 10;
        const orderB = qualityOrder[qualityB] || 10;

        if (orderA !== orderB) {
            return orderA - orderB;
        }

        const sizeAInBytes = parseSizeToBytes(a.size);
        const sizeBInBytes = parseSizeToBytes(b.size);

        if (sizeAInBytes !== sizeBInBytes) {
            return sizeBInBytes - sizeAInBytes;
        }

        const providerA = a.provider || 'default';
        const providerB = b.provider || 'default';

        const providerOrderA = providerSortKeys[providerA] || providerSortKeys.default;
        const providerOrderB = providerSortKeys[providerB] || providerSortKeys.default;

        return providerOrderA - providerOrderB;
    });
};

/**
 * Convert IMDb ID to TMDB ID
 */
const convertImdbToTmdb = async (imdbId, regionPreference = null, expectedType = null) => {
    console.time(`convertImdbToTmdb_total_${imdbId}`);

    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log('  Invalid IMDb ID format provided for conversion.', imdbId);
        console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
        return null;
    }

    console.log(`  Attempting to convert IMDb ID: ${imdbId} to TMDB ID${expectedType ? ` (expected type: ${expectedType})` : ''}.`);

    if (!TMDB_API_KEY) {
        console.error('[TMDB] TMDB_API_KEY is not configured.');
        console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
        return null;
    }

    const findApiUrl = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    console.log(`    Fetching IMDb ID ${imdbId} from TMDB find API.`);
    console.time(`convertImdbToTmdb_apiCall_${imdbId}`);

    try {
        const response = await axios.get(findApiUrl, { timeout: 10000 });
        console.timeEnd(`convertImdbToTmdb_apiCall_${imdbId}`);

        const findResults = response.data;

        if (findResults) {
            let result = null;

            if (expectedType === 'tv' || expectedType === 'series') {
                if (findResults.tv_results && findResults.tv_results.length > 0) {
                    result = {
                        tmdbId: String(findResults.tv_results[0].id),
                        tmdbType: 'tv',
                        title: findResults.tv_results[0].name || findResults.tv_results[0].original_name
                    };
                    console.log(`    Prioritized TV result for series request: ${result.title}`);
                } else if (findResults.movie_results && findResults.movie_results.length > 0) {
                    result = {
                        tmdbId: String(findResults.movie_results[0].id),
                        tmdbType: 'movie',
                        title: findResults.movie_results[0].title || findResults.movie_results[0].original_title
                    };
                    console.log(`    Fallback to movie result for series request: ${result.title}`);
                }
            } else if (expectedType === 'movie') {
                if (findResults.movie_results && findResults.movie_results.length > 0) {
                    result = {
                        tmdbId: String(findResults.movie_results[0].id),
                        tmdbType: 'movie',
                        title: findResults.movie_results[0].title || findResults.movie_results[0].original_title
                    };
                    console.log(`    Prioritized movie result for movie request: ${result.title}`);
                } else if (findResults.tv_results && findResults.tv_results.length > 0) {
                    result = {
                        tmdbId: String(findResults.tv_results[0].id),
                        tmdbType: 'tv',
                        title: findResults.tv_results[0].name || findResults.tv_results[0].original_name
                    };
                    console.log(`    Fallback to TV result for movie request: ${result.title}`);
                }
            } else {
                if (findResults.movie_results && findResults.movie_results.length > 0) {
                    result = {
                        tmdbId: String(findResults.movie_results[0].id),
                        tmdbType: 'movie',
                        title: findResults.movie_results[0].title || findResults.movie_results[0].original_title
                    };
                } else if (findResults.tv_results && findResults.tv_results.length > 0) {
                    result = {
                        tmdbId: String(findResults.tv_results[0].id),
                        tmdbType: 'tv',
                        title: findResults.tv_results[0].name || findResults.tv_results[0].original_name
                    };
                }
            }

            if (findResults.person_results && findResults.person_results.length > 0 && !result) {
                console.log(`    IMDb ID ${imdbId} resolved to a person, not a movie or TV show on TMDB.`);
            } else if (!result) {
                console.log(`    No movie or TV results found on TMDB for IMDb ID ${imdbId}. Response:`, JSON.stringify(findResults).substring(0, 200));
            }

            if (result && result.tmdbId && result.tmdbType) {
                console.log(`    Successfully converted IMDb ID ${imdbId} to TMDB ${result.tmdbType} ID ${result.tmdbId} (${result.title})`);
                console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
                return result;
            } else {
                console.log(`    Could not convert IMDb ID ${imdbId} to a usable TMDB movie/tv ID.`);
            }
        }
    } catch (error) {
        if (console.timeEnd && typeof console.timeEnd === 'function') {
            console.timeEnd(`convertImdbToTmdb_apiCall_${imdbId}`);
        }

        const errorMessage = error.response
            ? `${error.message} (Status: ${error.response.status})`
            : error.message;

        console.log(`    Error during TMDB find API call for IMDb ID ${imdbId}: ${errorMessage}`);
    }

    console.timeEnd(`convertImdbToTmdb_total_${imdbId}`);
    return null;
};

/**
 * Check quota for a cookie and return remaining MB
 */
const checkCookieQuota = async (cookie) => {
    try {
        const headers = {
            'Cookie': cookie.startsWith('ui=') ? cookie : `ui=${cookie}`,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        const resp = await axios.get('https://www.febbox.com/console/user_cards', {
            headers,
            timeout: 8000,
            validateStatus: () => true
        });

        if (resp.status === 200 && resp.data && resp.data.data && resp.data.data.flow) {
            const flow = resp.data.data.flow;
            const remaining = (Number(flow.traffic_limit_mb) || 0) - (Number(flow.traffic_usage_mb) || 0);
            return { ok: true, remainingMB: remaining, cookie };
        }
    } catch (e) {
        console.log(`[ShowBox] Quota check failed for cookie: ${e.message}`);
    }

    return { ok: false, remainingMB: -1, cookie };
};

/**
 * Select the best cookie from an array of cookies
 */
const selectBestCookie = async (cookies) => {
    let cookieArray = [];

    if (typeof cookies === 'string' && cookies.trim()) {
        cookieArray = [cookies.trim()];
    } else if (Array.isArray(cookies)) {
        cookieArray = cookies
            .filter(c => c && typeof c === 'string' && c.trim())
            .map(c => c.trim());
    }

    if (cookieArray.length === 0) {
        return { cookie: null, remainingMB: -1 };
    }

    if (cookieArray.length === 1) {
        const quotaResult = await checkCookieQuota(cookieArray[0]);
        console.log(`[ShowBox] Using single cookie${quotaResult.ok ? ` (${quotaResult.remainingMB} MB remaining)` : ' (quota check skipped/failed)'}`);
        return { cookie: quotaResult.cookie, remainingMB: quotaResult.remainingMB };
    }

    console.log(`[ShowBox] Checking quota for ${cookieArray.length} cookies...`);

    const quotaPromises = cookieArray.map(c => checkCookieQuota(c));
    const results = await Promise.all(quotaPromises);

    const successfulChecks = results.filter(r => r.ok);

    if (successfulChecks.length > 0) {
        successfulChecks.sort((a, b) => b.remainingMB - a.remainingMB);
        const best = successfulChecks[0];

        console.log(`[ShowBox] Selected best cookie by quota: ${best.remainingMB} MB remaining (out of ${successfulChecks.length} valid cookies)`);
        return { cookie: best.cookie, remainingMB: best.remainingMB };
    }

    const fallbackCookie = cookieArray[0];
    console.log('[ShowBox] All quota checks failed, using first cookie as fallback');

    return { cookie: fallbackCookie, remainingMB: -1 };
};

/**
 * Main function to get streams from TMDB ID using FebAPI
 */
const getStreamsFromTmdbId = async (
    tmdbType,
    tmdbId,
    seasonNum = null,
    episodeNum = null,
    regionPreference = null,
    cookies = null,
    userScraperApiKey = null
) => {
    const mainTimerLabel = `getStreamsFromTmdbId_total_${tmdbType}_${tmdbId}` +
        (seasonNum !== null ? `_s${seasonNum}` : '') +
        (episodeNum !== null ? `_e${episodeNum}` : '');

    console.time(mainTimerLabel);

    console.log(`[ShowBox] Getting streams for TMDB ${tmdbType}/${tmdbId}${seasonNum !== null ? `, Season ${seasonNum}` : ''}${episodeNum !== null ? `, Episode ${episodeNum}` : ''}`);

    try {
        const { cookie: selectedCookie } = await selectBestCookie(cookies);

        const oss = regionPreference || 'USA7';
        let apiUrl;

        if (tmdbType === 'tv' || tmdbType === 'series') {
            if (seasonNum === null || episodeNum === null) {
                console.log('[ShowBox] TV request requires season and episode numbers.');
                return [];
            }

            apiUrl = `${FEBAPI_BASE_URL}/tv/${tmdbId}/oss=${oss}/${seasonNum}/${episodeNum}`;
        } else if (tmdbType === 'movie') {
            apiUrl = `${FEBAPI_BASE_URL}/movie/${tmdbId}/oss=${oss}`;
        } else {
            console.log(`[ShowBox] Unsupported media type: ${tmdbType}`);
            return [];
        }

        const requestUrl = selectedCookie
            ? `${apiUrl}?cookie=${encodeURIComponent(selectedCookie)}`
            : apiUrl;

        console.log(`[ShowBox] Requesting FebAPI for ${tmdbType}/${tmdbId} (cookie ${selectedCookie ? 'included' : 'not included'}).`);

        const response = await axios.get(requestUrl, {
            timeout: 30000,
            headers: {
                'User-Agent': 'NuvioStreamsAddon/1.0',
                'Accept': 'application/json'
            },
            validateStatus: status => status >= 200 && status < 500
        });

        console.log(`[ShowBox] FebAPI HTTP status: ${response.status}`);

        if (response.status < 200 || response.status >= 300) {
            console.error(`[ShowBox] FebAPI returned HTTP ${response.status}.`);
            return [];
        }

        const apiData = response.data;

        if (!apiData || typeof apiData !== 'object') {
            console.error('[ShowBox] FebAPI returned an empty or non-JSON response.');
            return [];
        }

        const versions = Array.isArray(apiData.versions)
            ? apiData.versions
            : (Array.isArray(apiData.data?.versions) ? apiData.data.versions : []);

        if (versions.length === 0) {
            console.log('[ShowBox] No versions found in FebAPI response.');
            console.log(`[ShowBox] API success flag: ${String(apiData.success)}`);

            if (apiData.message) {
                console.log(`[ShowBox] API message: ${String(apiData.message).slice(0, 300)}`);
            }

            return [];
        }

        const streams = [];

        for (const version of versions) {
            const versionName = version.name || version.title || 'Unknown';
            const versionSize = version.size || 'Unknown size';
            const links = Array.isArray(version.links) ? version.links : [];

            for (const link of links) {
                const streamUrl = link.url || link.file || link.link;

                if (typeof streamUrl !== 'string' || !/^https?:\/\//i.test(streamUrl)) {
                    continue;
                }

                const streamName = link.name || 'Auto';
                const streamQuality = parseQualityFromLabel(link.quality || link.name || versionName);
                const streamSize = link.size || versionSize;
                const streamCodecs = extractCodecDetails(`${versionName} ${link.name || ''}`);

                streams.push({
                    name: streamName,
                    title: versionName,
                    url: streamUrl,
                    quality: streamQuality,
                    codecs: streamCodecs,
                    size: streamSize,
                    provider: 'ShowBox'
                });
            }
        }

        console.log(`[ShowBox] Versions received: ${versions.length}; streams parsed: ${streams.length}`);

        return sortStreamsByQuality(streams);

    } catch (error) {
        const status = error.response?.status;

        console.error(`[ShowBox] Error fetching streams: ${error.message}${status ? ` (HTTP ${status})` : ''}`);

        if (error.response?.data) {
            const safeData = { ...error.response.data };
            delete safeData.cookie;
            delete safeData.token;

            console.error('[ShowBox] Error response:', JSON.stringify(safeData).slice(0, 500));
        }

        return [];
    } finally {
        console.timeEnd(mainTimerLabel);
    }
};

// Export required functions
module.exports = {
    getStreamsFromTmdbId,
    parseQualityFromLabel,
    convertImdbToTmdb,
    sortStreamsByQuality
};
