(async () => {
  const startTime = performance.now();
  console.log("🚀 Start pipeline...");

  const TOKEN = "PASTE_TOKEN_HERE";

  // ===== CONFIG =====
  const BATCH_SIZE = 3;
  const BASE_DELAY = 1000;

  // ===== CACHE =====
  const dictCache = {};

  // ===== UTILS =====
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const chunk = (arr, size) => {
    const res = [];
    for (let i = 0; i < arr.length; i += size) {
      res.push(arr.slice(i, i + size));
    }
    return res;
  };

  const isValidWord = (w) => /^[a-zA-Z]{3,}$/.test(w);

  function cleanLLMOutput(text) {
    return text
      .replace(/<[^>]*>/g, "")
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .trim();
  }

  function mapResult(arr) {
    const result = {};
    for (const item of arr) {
      if (!item.word) continue;
      result[item.word.toLowerCase()] = item.usage || "";
    }
    return result;
  }

  function safeParseJSON(text) {
    try {
      return mapResult(JSON.parse(text));
    } catch {}

    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        return mapResult(JSON.parse(match[0]));
      }
    } catch {}

    // salvage
    const result = {};
    const matches = text.match(/\{[\s\S]*?\}/g);

    if (matches) {
      for (const m of matches) {
        try {
          const obj = JSON.parse(m);
          if (obj.word) {
            result[obj.word.toLowerCase()] = obj.usage || "";
          }
        } catch {}
      }
    }

    return result;
  }

  // ===== TECHNICAL TERMS WHITELIST =====
  const technicalTerms = new Set([
    'json', 'serialization', 'deserialization', 'api', 'polymorphism',
    'abstraction', 'encapsulation', 'inheritance', 'interface', 'protocol',
    'algorithm', 'namespace', 'decorator', 'middleware', 'callback'
  ]);

  async function isRealEnglishWord(word, retry = 0) {
    // Check technical terms whitelist first
    if (technicalTerms.has(word.toLowerCase())) {
      return true;
    }

    if (dictCache[word] !== undefined) {
      return dictCache[word];
    }

    try {
      // Use CORS proxy to bypass restriction
      const res = await fetch(
        `https://cors-anywhere.herokuapp.com/https://api.dictionaryapi.dev/api/v2/entries/en/${word}`
      );

      // Handle rate limiting
      if (res.status === 429) {
        if (retry < 3) {
          console.log(`⏳ Rate limit hit, waiting... (retry ${retry + 1})`);
          await sleep(3000 * (retry + 1));
          return isRealEnglishWord(word, retry + 1);
        }
        dictCache[word] = false;
        return false;
      }

      if (!res.ok) {
        dictCache[word] = false;
        return false;
      }

      const data = await res.json();
      const valid = Array.isArray(data) && data.length > 0;

      dictCache[word] = valid;
      return valid;
    } catch {
      dictCache[word] = false;
      return false;
    }
  }

  // ===== EXTRACT WORD =====
  const raw = [];

  document.querySelectorAll("h4").forEach((h4) => {
    const match = h4.innerText.match(/Rank (\d+)/);
    if (!match) return;

    const rank = parseInt(match[1]);
    if (rank < 8000) return;

    const container = h4.nextElementSibling;
    if (!container) return;

    container.querySelectorAll(".lln-word").forEach((w) => {
      const key = w.getAttribute("data-word-key");
      const word = key?.split("|")[1] || w.innerText.trim();

      if (word && isValidWord(word)) {
        raw.push(word.toLowerCase().trim());
      }
    });
  });

  const words = [...new Set(raw)].slice(0, 50);
  console.log(`📊 Words: ${words.length}`);

  // ===== VALIDATE WORDS FIRST =====
  const validWords = [];
  for (const word of words) {
    console.log(`🧐 Validating: ${word}`);
    const isValid = await isRealEnglishWord(word);
    await sleep(300); // Rate limiting

    if (isValid) {
      validWords.push(word);
      console.log(`✅ Valid: ${word}`);
    } else {
      console.log(`🚫 Rejected: ${word}`);
    }
  }

  console.log(`✅ Valid words: ${validWords.length}`);
  if (validWords.length === 0) {
    console.log("No valid words found!");
    return;
  }

  // ===== API =====
  async function getMeaning(word) {
    try {
      const res = await fetch(
        `https://api-cdn-plus.dioco.io/base_dict_getHoverDict_8?form=${word}&lemma=&sl=en&tl=vi&pos=ANY&pow=n`
      );

      const data = await res.json();
      return data?.data?.hoverDictEntries?.join(", ") || "";
    } catch {
      return "";
    }
  }

  async function getUsageBatch(words, retry = 0) {
    const prompt = `
Giải thích NGẮN GỌN (1 câu) cách dùng các từ sau bằng tiếng Việt.

Yêu cầu:
- CHỈ trả về JSON
- KHÔNG markdown

Format:
[{"word":"...","usage":"..."}]

Danh sách:
${words.join(", ")}
`;

    try {
      const res = await fetch(
        "https://api-cdn-plus.dioco.io/base_lexa_generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptWithPlaceHolders_translated: prompt,
            contextSentence: "",
            word: words[0],
            userLanguage_G: "vi",
            studyLanguage_G: "en",
            diocoToken: TOKEN,
          }),
        }
      );

      if (res.status === 429) throw new Error("RATE_LIMIT");

      const data = await res.json();
      let text = cleanLLMOutput(data?.data?.generation || "");

      return safeParseJSON(text);
    } catch (e) {
      if (retry < 3) {
        console.log(`🔁 Retry batch ${retry + 1}`);
        await sleep(1500 * (retry + 1));
        return getUsageBatch(words, retry + 1);
      }
      return {};
    }
  }

  // ===== PIPELINE =====
  const batches = chunk(validWords, BATCH_SIZE);
  const output = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    console.log(`📤 Batch ${i + 1}/${batches.length}`, batch);

    const usageMap = await getUsageBatch(batch);

    for (const word of batch) {
      let usage = usageMap[word] || "";
      let meaning = await getMeaning(word);

      if (!meaning && !usage) continue;

      output.push({ word, meaning, usage });
    }

    await sleep(BASE_DELAY);
  }

  // ===== EXPORT =====
  const now = new Date();
  const timestamp = now.toISOString().split('T')[0]; // YYYY-MM-DD format
  
  const csv = output
    .map((x) => {
      const m = (x.meaning || "").replace(/"/g, '""');
      const u = (x.usage || "").replace(/"/g, '""');
      return `${x.word},"${m}","${u}"`;
    })
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");

  a.href = URL.createObjectURL(blob);
  a.download = `anki_vocab_clean_${timestamp}.csv`;
  a.click();

  console.log("✅ DONE");
})();