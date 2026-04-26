// static/js/utils/thumbnails.js
// Shared thumbnail utilities — extracted from digital-library.html.

/**
 * Normalise a raw thumbnail value to a /thumbs/-prefixed local path or a full URL.
 * @param {string} t
 * @returns {string|null}
 */
export function thumbSrc(t) {
    const raw = String(t || '').trim();
    if (!raw) return null;
    if (
        /^(https?:|data:|blob:)/i.test(raw) ||
        raw.startsWith('/thumbs/') ||
        raw.startsWith('/static/')
    ) return raw;

    let path = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
    const lower = path.toLowerCase();

    if (lower.startsWith('/music/')) {
        return '/thumbs/' + path.slice('/music/'.length);
    }
    if (lower.startsWith('music/')) {
        return '/thumbs/' + path.slice('music/'.length);
    }

    const musicIdx = lower.lastIndexOf('/music/');
    if (musicIdx >= 0) {
        return '/thumbs/' + path.slice(musicIdx + '/music/'.length);
    }

    const filename = path.split('/').filter(Boolean).pop();
    return filename ? '/thumbs/' + filename : null;
}

/**
 * Build a priority-ordered list of thumbnail URLs for a track, with YouTube
 * fallback chain (maxres → hq → original).
 * @param {{ thumbnail?: string, id?: string, track_id?: string }} track
 * @returns {string[]}
 */
export function getThumbnailCandidates(track) {
    const normalized = thumbSrc(track?.thumbnail || '');
    const trackId = track?.id || track?.track_id || '';
    const isYouTubeId = typeof trackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(trackId);
    const isDiscogs = normalized && normalized.includes('discogs.com');

    const discogsCandidates = [];
    const youtubeCandidates = [];

    if (normalized && !normalized.includes('i.ytimg.com/vi/')) {
        discogsCandidates.push(normalized);
    }

    if (isYouTubeId && !isDiscogs) {
        youtubeCandidates.push(`https://i.ytimg.com/vi/${trackId}/maxresdefault.jpg`);
        youtubeCandidates.push(`https://i.ytimg.com/vi/${trackId}/hqdefault.jpg`);
    }

    if (normalized && normalized.includes('i.ytimg.com/vi/')) {
        youtubeCandidates.push(normalized.replace(/\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.(?:jpg|webp).*$/i, '/maxresdefault.jpg'));
        youtubeCandidates.push(normalized.replace(/\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.(?:jpg|webp).*$/i, '/hqdefault.jpg'));
        youtubeCandidates.push(normalized);
    }

    return [...new Set([...discogsCandidates, ...youtubeCandidates].filter(Boolean))];
}

/**
 * Cascade through a list of image URLs on an <img> element, trying the next
 * candidate whenever the current one fails to load.
 * @param {HTMLImageElement} img
 * @param {string[]} candidates
 */
export function cascadeImage(img, candidates) {
    if (!img || !Array.isArray(candidates) || !candidates.length) return;
    let idx = 0;
    img.onerror = () => {
        idx += 1;
        if (idx >= candidates.length) {
            img.onerror = null;
            return;
        }
        img.src = candidates[idx];
    };
}

/**
 * Escape a string for safe HTML insertion.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

/**
 * Format seconds into "M:SS".
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
    const s = Math.floor(seconds || 0);
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
}
