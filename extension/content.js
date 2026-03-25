if (window.__LR_CONTENT_LOADED) {
  // Already injected — skip duplicate registration.
} else {
  window.__LR_CONTENT_LOADED = true;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type !== 'extract-words') return false;

  const maxWords = request.maxWords || 200;
  const rankMode = request.rankMode || 'gte'; // 'gte' | 'lte' | 'range'
  const minRank = Number.isFinite(request.minRank) ? request.minRank : (request.minRank ?? 8000);
  const maxRank = Number.isFinite(request.maxRank) ? request.maxRank : request.maxRank;

  function rankToBucket(rank) {
    if (rank >= 8000) return '8000+';
    if (rank >= 6001 && rank <= 8000) return '6001-8000';
    if (rank >= 1) {
      const start = Math.floor((rank - 1) / 100) * 100 + 1;
      const end = start + 99;
      return `${start}-${end}`;
    }
    return '0-0';
  }

  function matchesRank(rank) {
    if (!Number.isFinite(rank)) return false;

    if (rankMode === 'lte') {
      const upper = Number.isFinite(maxRank) ? maxRank : minRank;
      return rank <= upper;
    }
    if (rankMode === 'range') {
      const lower = Number.isFinite(minRank) ? minRank : 0;
      const upper = Number.isFinite(maxRank) ? maxRank : lower;
      return rank >= lower && rank <= upper;
    }
    // default: gte
    return rank >= minRank;
  }

  const raw = [];

  document.querySelectorAll('h4').forEach((h4) => {
    const match = h4.innerText.match(/Rank\s*(\d+)/);
    if (!match) return;
    const rank = parseInt(match[1]);

    // Bucket is mostly for grouping/debugging; filtering is numeric via matchesRank().
    const bucket = rankToBucket(rank);
    if (!matchesRank(rank)) return;

    const container = h4.nextElementSibling;
    if (!container) return;
    container.querySelectorAll('.lln-word').forEach((w) => {
      const key = w.getAttribute('data-word-key');
      const word = key?.split('|')[1] || w.innerText.trim();
      if (!word) return;
      const cleaned = word.toLowerCase().trim();
      if (/^[a-zA-Z]{3,}$/.test(cleaned)) raw.push(cleaned);
    });
  });

  if (raw.length === 0) {
    document.querySelectorAll('.lln-word').forEach((w) => {
      const key = w.getAttribute('data-word-key');
      const word = key?.split('|')[1] || w.innerText.trim();
      if (!word) return;
      const cleaned = word.toLowerCase().trim();
      if (/^[a-zA-Z]{3,}$/.test(cleaned)) raw.push(cleaned);
    });
  }

  const words = [...new Set(raw)].slice(0, maxWords);
  sendResponse({ words });
  return true;
});

} // end guard
