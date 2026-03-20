// Run this in Language Reactor browser console to extract words
// It will log and copy words to clipboard

(async () => {
  // Optional configuration (set these before running the snippet):
  // - window.LR_MIN_RANK: number (default 8000)
  // - window.LR_SERVER_URL: string like "http://127.0.0.1:4567/words"
  // - window.LR_YOUTUBE_URL: string (optional, for logging)
  const MIN_RANK = Number(window.LR_MIN_RANK ?? 8000);
  const SERVER_URL = typeof window.LR_SERVER_URL === 'string' ? window.LR_SERVER_URL : '';
  const YOUTUBE_URL = typeof window.LR_YOUTUBE_URL === 'string' ? window.LR_YOUTUBE_URL : '';

  console.log("📚 Extracting words from Language Reactor...");

  const raw = [];

  // Extract from h4 elements with Rank
  document.querySelectorAll("h4").forEach((h4) => {
    const match = h4.innerText.match(/Rank (\d+)/);
    if (!match) return;

    const rank = parseInt(match[1]);
    if (rank < MIN_RANK) return;

    const container = h4.nextElementSibling;
    if (!container) return;

    container.querySelectorAll(".lln-word").forEach((w) => {
      const key = w.getAttribute("data-word-key");
      const word = key?.split("|")[1] || w.innerText.trim();

      if (word && /^[a-zA-Z]{3,}$/.test(word)) {
        raw.push(word.toLowerCase().trim());
      }
    });
  });

  const words = [...new Set(raw)];
  console.log(`✅ Extracted ${words.length} unique words:`);
  console.log(words.join('\n'));

  if (SERVER_URL) {
    // Send to local Node runner for fully automated export.
    const resp = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words, youtubeUrl: YOUTUBE_URL })
    });
    console.log("📡 Server response:", await resp.text());
  } else {
    // Copy to clipboard (original workflow).
    const text = words.join('\n');
    await navigator.clipboard.writeText(text);
    console.log("📋 Words copied to clipboard! Paste into word_list.txt");
  }
})();
