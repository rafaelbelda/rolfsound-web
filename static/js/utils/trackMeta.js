export function getDisplayArtist(track = {}) {
  if (!track) return '';
  return String(
    track.display_artist ||
    track.artist ||
    track.channel ||
    ''
  ).trim();
}

export function getArtistCredits(track = {}) {
  return Array.isArray(track?.artists) ? track.artists : [];
}

export function getArtistNames(track = {}) {
  const names = getArtistCredits(track)
    .map((artist) => artist?.name || artist?.artist || '')
    .filter(Boolean);
  const display = getDisplayArtist(track);
  if (display) names.push(display);
  return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
}

export function getPrimaryArtist(track = {}) {
  if (track?.primary_artist?.name) return track.primary_artist;
  const credits = getArtistCredits(track);
  return credits.find((artist) => artist?.is_primary) || credits[0] || null;
}

export function getAlbum(track = {}) {
  if (track?.album) return track.album;
  const albums = Array.isArray(track?.albums) ? track.albums : [];
  return albums[0] || null;
}

export function getAlbumTitle(track = {}) {
  const album = getAlbum(track);
  return String(album?.title || track?.album_title || '').trim();
}

export function getSearchText(track = {}) {
  return [
    track?.title || '',
    getDisplayArtist(track),
    getAlbumTitle(track),
    ...getArtistNames(track),
  ].join(' ').toLowerCase();
}

export function withDisplayArtist(track = {}) {
  const displayArtist = getDisplayArtist(track);
  return {
    ...track,
    display_artist: displayArtist,
    artist: displayArtist,
  };
}
