(async () => {
  const startTime = performance.now();

  console.log("🚀 Start pipeline...");

  // ===== 1. EXTRACT WORD =====
  const result = [];

  document.querySelectorAll("h4").forEach(h4 => {
    const match = h4.innerText.match(/Rank (\d+)/);
    if (!match) return;

    const startRank = parseInt(match[1]);

    if (startRank >= 8000) {
      const container = h4.nextElementSibling;
      if (!container) return;

      container.querySelectorAll(".lln-word").forEach(w => {
        const key = w.getAttribute("data-word-key");
        const word = key?.split("|")[1] || w.innerText.trim();
        if (word) result.push(word.toLowerCase());
      });
    }
  });

  const words = [...new Set(result)].slice(0, 50);

  console.log(`📊 Total words: ${words.length}`);

  const TOKEN = "PASTE_TOKEN";

  // ===== 2. GET MEANING =====
  async function getMeaning(word) {
    try {
      const res = await fetch(
        `https://api-cdn-plus.dioco.io/base_dict_getHoverDict_8?form=unvalidated&lemma=${word}&sl=en&tl=vi&pos=ANY&pow=n`
      );
      const data = await res.json();

      return data?.data?.hoverDictEntries?.[0] || "";
    } catch {
      return "";
    }
  }

  // ===== 3. POST USAGE (có retry) =====
  async function getUsage(word, retry = 0) {
    try {
      const res = await fetch("https://api-cdn-plus.dioco.io/base_lexa_generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptWithPlaceHolders_translated:
            "Vui lòng giải thích cách sử dụng từ <WORD> trong câu này: <CONTEXT>",
          contextSentence: "",
          word,
          userLanguage_G: "vi",
          studyLanguage_G: "en",
          diocoToken: TOKEN
        })
      });

      if (res.status === 429) {
        throw new Error("RATE_LIMIT");
      }

      const data = await res.json();

      let text = data?.data?.generation || "";

      // 1. remove HTML tag
      text = text.replace(/<[^>]*>/g, "");

      // 2. decode HTML entity
      text = decodeHTML(text);

      return text.trim();
    } catch (e) {
      if (retry < 3) {
        console.log(`🔁 Retry ${word} (${retry + 1})`);
        await new Promise(r => setTimeout(r, 1500));
        return getUsage(word, retry + 1);
      }
      return "";
    }
  }

  // ===== 4. PHASE 1: GET MEANING =====
  console.log("📥 Phase 1: GET meaning...");

  const meaningMap = {};

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    console.log(`GET ${i + 1}/${words.length}: ${word}`);

    meaningMap[word] = await getMeaning(word);

    await new Promise(r => setTimeout(r, 100)); // nhẹ
  }

  // ===== 5. PHASE 2: POST USAGE =====
  console.log("📤 Phase 2: POST usage...");

  const output = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    console.log(`POST ${i + 1}/${words.length}: ${word}`);

    const usage = await getUsage(word);

    output.push({
      word,
      meaning: meaningMap[word] || "",
      usage
    });

    // 🚨 throttle cực quan trọng
    await new Promise(r => setTimeout(r, 800));
  }

  // ===== 6. CSV =====
  const csv = output
    .map(x => {
      const m = x.meaning.replace(/"/g, '""');
      const u = x.usage.replace(/"/g, '""');

      return `${x.word},"${m}","${u}"`;
    })
    .join("\n");

  // ===== 7. DOWNLOAD =====
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");

  a.href = URL.createObjectURL(blob);
  a.download = "anki_vocab_pipeline.csv";
  a.click();

  const endTime = performance.now();

  console.log("✅ DONE!");
  console.log(`⏱ Time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
})();