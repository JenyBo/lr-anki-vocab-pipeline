// Run this in Language Reactor browser console to extract words
// It will log and copy words to clipboard

(async () => {
  console.log("📚 Extracting words from Language Reactor...");

  const raw = [];

  // Extract from h4 elements with Rank
  document.querySelectorAll("h4").forEach((h4) => {
    const match = h4.innerText.match(/Rank (\d+)/);
    if (!match) return;

    const rank = parseInt(match[1]);
    if (rank < 8000) return; // Adjust range as needed

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

  // Copy to clipboard
  const text = words.join('\n');
  await navigator.clipboard.writeText(text);
  console.log("📋 Words copied to clipboard! Paste into word_list.txt");
})();
