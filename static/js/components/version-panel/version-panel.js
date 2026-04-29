import { getDisplayArtist } from '/static/js/utils/trackMeta.js';

export function initVersionPanel({
  thumbSrc, escapeHtml, getTrackId, getAssets, getFastAssetId, getFastAsset,
  normalizeAssetType, getFileFormat, assetDisplay, notify,
  updateTrackCache, renderLibrary, getCurrentSearchQuery,
  findTrackById, playTrack, queueTrack, editIdentity
}) {
  let state = null;

  function sortVersionAssets(track) {
    const fastId = getFastAssetId(track);
    const priority = {
      FLAC: 0, ORIGINAL_MIX: 1, ALT_VERSION: 2, REMIX: 3, LIVE: 4,
      RADIO_EDIT: 5, DEMO: 6, INSTRUMENTAL: 7, RECORDING: 8
    };
    return [...getAssets(track)].sort((a, b) => {
      if (a.id === fastId) return -1;
      if (b.id === fastId) return 1;
      const ap = Number(a.is_primary) === 1 ? -1 : 0;
      const bp = Number(b.is_primary) === 1 ? -1 : 0;
      if (ap !== bp) return ap - bp;
      const at = normalizeAssetType(a.asset_type);
      const bt = normalizeAssetType(b.asset_type);
      const af = getFileFormat(a) === 'FLAC' ? 'FLAC' : at;
      const bf = getFileFormat(b) === 'FLAC' ? 'FLAC' : bt;
      const ar = priority[af] ?? 20;
      const br = priority[bf] ?? 20;
      if (ar !== br) return ar - br;
      return Number(a.date_added || 0) - Number(b.date_added || 0);
    });
  }

  async function fetchFullTrack(track) {
    const trackId = getTrackId(track);
    if (!trackId) return track;
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(trackId)}`);
      if (!response.ok) throw new Error(`Track fetch failed (${response.status})`);
      const fullTrack = await response.json();
      updateTrackCache(fullTrack);
      return fullTrack;
    } catch (error) {
      console.error('Track details error:', error);
      return track;
    }
  }

  function renderVersionRows(track) {
    const assets = sortVersionAssets(track);
    const fastId = getFastAssetId(track);

    if (!assets.length) {
      return '<div style="padding:18px;text-align:center;color:var(--color-text-disabled);font-size:var(--fs-sm)">No versions registered</div>';
    }

    return assets.map((asset, index) => {
      const display = assetDisplay(asset);
      const isFast = asset.id === fastId;
      const isPrimary = Number(asset.is_primary) === 1;
      const status = [];
      if (isFast) status.push('<span class="version-status fast">Fast Play</span>');
      else if (isPrimary) status.push('<span class="version-status">Primary</span>');
      if (asset.analysis_status && !['identified', 'complete'].includes(String(asset.analysis_status).toLowerCase())) {
        status.push(`<span class="version-status pending">${escapeHtml(String(asset.analysis_status))}</span>`);
      }
      const defaultText = isFast ? 'Fast' : 'Set';
      const aria = isFast ? 'Current fast play version' : 'Use for fast play';

      return `
        <div class="version-row ${isFast ? 'is-fast' : ''}" data-asset-id="${escapeHtml(asset.id || '')}" style="--row-delay:${index * 42}ms">
          <button class="version-play-btn hover-target" type="button" data-action="play-version" title="Play version" aria-label="Play ${escapeHtml(display.label)}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <div class="version-main">
            <div class="version-name-line">
              <span class="version-name">${escapeHtml(display.label)}</span>
              ${status.join('')}
            </div>
            <div class="version-detail-line" title="${escapeHtml(asset.file_path || '')}">
              ${escapeHtml(display.detail || 'Asset')}
            </div>
          </div>
          <div class="version-actions">
            <button class="version-icon-btn hover-target" type="button" data-action="queue-version" title="Add version to queue" aria-label="Add version to queue">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 6h11v2H4V6Zm0 5h11v2H4v-2Zm0 5h7v2H4v-2Zm14-5V8h2v3h3v2h-3v3h-2v-3h-3v-2h3Z"/>
              </svg>
            </button>
            <button class="version-default-btn hover-target" type="button" data-action="set-fast-version" ${isFast ? 'disabled' : ''} title="${aria}">
              ${defaultText}
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderContent(panel, track) {
    const imgSrc = thumbSrc(track.thumbnail);
    const fastAsset = getFastAsset(track);
    const fastDisplay = fastAsset ? assetDisplay(fastAsset) : null;
    const assets = getAssets(track);

    panel.innerHTML = `
      <div class="version-panel-inner">
        <div class="version-panel-header">
          <div class="version-panel-cover">
            ${imgSrc ? `<img src="${escapeHtml(imgSrc)}" alt="" loading="lazy" onerror="this.outerHTML='Audio'" />` : 'Audio'}
          </div>
          <div class="version-panel-title">
            <strong>${escapeHtml(track.title || 'Unknown')}</strong>
            <span>${escapeHtml(getDisplayArtist(track) || 'Unknown Artist')} · ${assets.length} ${assets.length === 1 ? 'version' : 'versions'}</span>
          </div>
          <button class="version-panel-edit hover-target" type="button" data-action="edit-identity" aria-label="Edit identity" title="Edit identity">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>
          <button class="version-panel-close hover-target" type="button" data-action="close-version-panel" aria-label="Close versions">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div class="version-fast-card">
          <div class="version-fast-label">Fast Play</div>
          <div class="version-fast-value">${escapeHtml(fastDisplay?.label || 'Not set')}</div>
          <div class="version-fast-detail">${escapeHtml(fastDisplay?.detail || 'No asset available')}</div>
        </div>
        <div class="version-list">
          ${renderVersionRows(track)}
        </div>
      </div>
    `;
  }

  function close() {
    if (!state) return;
    const { backdrop, panel } = state;
    panel.classList.add('closing');
    panel.classList.remove('active');
    backdrop.classList.remove('active');
    window.setTimeout(() => { panel.remove(); backdrop.remove(); }, 220);
    state = null;
  }

  async function open(track, anchorEl = null) {
    const trackId = getTrackId(track);
    if (!trackId) { notify('Track unavailable'); return; }

    close();
    const fullTrack = await fetchFullTrack(track);

    const backdrop = document.createElement('div');
    backdrop.className = 'version-panel-backdrop';
    document.body.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.className = 'version-panel';
    panel.dataset.trackId = trackId;

    renderContent(panel, fullTrack);
    document.body.appendChild(panel);
    state = { backdrop, panel, trackId, track: fullTrack };

    requestAnimationFrame(() => {
      backdrop.classList.add('active');
      panel.classList.add('active');
    });

    backdrop.addEventListener('click', close);
    panel.addEventListener('click', handleClick);
  }

  async function setFastPlayVersion(trackId, assetId, panel) {
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(trackId)}/preferred-asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId })
      });
      if (!response.ok) throw new Error(`Set fast play failed (${response.status})`);
      const data = await response.json();
      const updatedTrack = data.track || await fetchFullTrack({ id: trackId });
      updateTrackCache(updatedTrack);
      if (state?.trackId === trackId) state.track = updatedTrack;
      renderContent(panel, updatedTrack);
      renderLibrary(getCurrentSearchQuery());
      notify('Fast Play updated');
    } catch (error) {
      console.error('Set fast play error:', error);
      notify('Fast Play update failed');
    }
  }

  async function handleClick(event) {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl || !state) return;

    const action = actionEl.dataset.action;
    if (action === 'close-version-panel') { close(); return; }
    if (action === 'edit-identity') {
      const track = state.track || findTrackById(state.trackId);
      if (track && typeof editIdentity === 'function') await editIdentity(track, state.panel);
      return;
    }

    const row = actionEl.closest('.version-row');
    const assetId = row?.dataset.assetId || '';
    const trackId = state.trackId;
    const track = findTrackById(trackId);
    if (!track || !assetId) return;

    if (action === 'play-version') { await playTrack(track, assetId); return; }
    if (action === 'queue-version') { await queueTrack(track, assetId); return; }
    if (action === 'set-fast-version') { await setFastPlayVersion(trackId, assetId, state.panel); }
  }

  return { open, close };
}
