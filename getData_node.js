import fetch from 'node-fetch';
import fs from 'fs';

(async () => {
  const startTime = performance.now();
  console.log("🚀 Start pipeline...");

  // Read token from file
  const TOKEN = fs.readFileSync('./token.txt', 'utf-8').trim();

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

  // Check if LLM rejected a word in its response
  function isLLMRejection(usage) {
    if (!usage) return false;
    
    const usageLower = usage.toLowerCase().trim();
    
    // Only reject if LLM explicitly says it doesn't exist or is a typo
    // These are strong rejection signals, not part of normal definitions
    const strongRejections = [
      "không phải là một từ tiếng anh có nghĩa",  // not an English word with meaning
      "không phải là từ tiếng anh",               // not an English word
      "không tồn tại trong tiếng anh",            // doesn't exist in English
      "tidak ada dalam bahasa inggris",           // doesn't exist in English (other form)
      "lỗi chính tả của",                         // typo of...
      "lỗi chính tả",                             // just typo
      "từ giả",                                   // fake word
      "đây không phải",                           // this is not
      "đây là một",                               // this is a (typo/error)
      "đây không tồn",                            // this doesn't exist
    ];
    
    // Check if any strong rejection is present
    return strongRejections.some(pattern => usageLower.includes(pattern));
  }

  // ===== API =====
  async function getMeaning(word) {
    try {
      const res = await fetch(
        `https://api-cdn-plus.dioco.io/base_dict_getHoverDict_8?form=${word}&lemma=&sl=en&tl=vi&pos=ANY&pow=n`
      );

      const data = await res.json();
      const meaning = data?.data?.hoverDictEntries?.join(", ") || "";
      
      // Return empty if no meaningful definition found
      if (!meaning || meaning.length < 5) {
        return "";
      }
      
      return meaning;
    } catch {
      return "";
    }
  }

  async function getUsageBatch(words, retry = 0) {
    // Updated prompt that asks LLM to validate word existence
    const prompt = `Bạn là một độc giả từ điển chuyên nghiệp. 

Nhiệm vụ: Kiểm tra và giải thích các từ tiếng Anh sau

QUY TẮC QUAN TRỌNG:
- CHỈ trả về JSON
- Nếu từ KHÔNG tồn tại trong tiếng Anh thực (không phải từ thực, là lỗi chính tả, hoặc từ giả):
  * Đặt "usage" = "" (chuỗi trống)
- Nếu từ TỒN TẠI: Giải thích 1 câu cách dùng trong tiếng Việt
- Kiểm tra từ bằng: từ điển, ví dụ Google, ngữ cảnh sử dụng thực tế
- KHÔNG chấp nhận từ không có trong từ điển (fake words, typos như: cartisian, tupil, hoc)

Format:
[{"word":"...","usage":"..."}]

Danh sách từ cần kiểm tra:
${words.join(", ")}

Trả về JSON:`;

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

  // ===== EXTRACT WORD (from CSV file) =====
  const raw = [];
  const csvFile = './word_list.txt'; // You need to provide word list

  // For now, use example words or read from file if exists
  if (fs.existsSync(csvFile)) {
    const content = fs.readFileSync(csvFile, 'utf-8');
    const words_list = content.split('\n').map(w => w.trim()).filter(w => isValidWord(w));
    raw.push(...words_list);
  } else {
    console.log("⚠️  No word_list.txt found. Please create it with words (one per line)");
    return;
  }

  const words = [...new Set(raw)].slice(0, 100);
  console.log(`📊 Words extracted: ${words.length}`);

  // ===== VALIDATE & GET DATA IN ONE PASS =====
  // Let LLM APIs handle validation via their prompts
  const validWords = [];
  const rejectedWords = [];
  
  console.log(`\n📝 Validating and getting meanings/usage...`);

  const batches = chunk(words, BATCH_SIZE);
  const output = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    console.log(`📤 Batch ${i + 1}/${batches.length}`, batch);

    // Get LLM usage validation (with word existence check in prompt)
    const usageMap = await getUsageBatch(batch);

    for (const word of batch) {
      const usage = usageMap[word] || "";
      const meaning = await getMeaning(word);

      console.log(`  📊 ${word}: usage=${usage.length > 0 ? '✓' : '✗'}, meaning=${meaning.length > 0 ? '✓' : '✗'}`);

      // Check if LLM rejected the word
      if (isLLMRejection(usage)) {
        console.log(`  ❌ LLM rejected: "${usage.substring(0, 50)}..."`);
        rejectedWords.push(word);
        continue;
      }

      // Accept only if BOTH meaning and usage are present
      if (meaning && usage) {
        console.log(`  ✅ Accepted: ${word}`);
        validWords.push(word);
        output.push({ word, meaning, usage });
      } else {
        console.log(`  ❌ Rejected: ${word}`);
        rejectedWords.push(word);
      }
    }

    await sleep(BASE_DELAY);
  }

  console.log(`\n📊 VALIDATION SUMMARY:`);
  console.log(`✅ Valid words: ${validWords.length}`);
  console.log(`🚫 Rejected words (${rejectedWords.length}): ${rejectedWords.join(', ')}`);
  
  if (output.length === 0) {
    console.log("No valid words found!");
    return;
  }

  // ===== EXPORT =====
  const now = new Date();
  const timestamp = now.toISOString().split('T')[0];

  const csv = output
    .map((x) => {
      const m = (x.meaning || "").replace(/"/g, '""');
      const u = (x.usage || "").replace(/"/g, '""');
      return `${x.word},"${m}","${u}"`;
    })
    .join("\n");

  const outputFile = `anki_vocab_clean_${timestamp}.csv`;
  fs.writeFileSync(outputFile, csv);

  console.log(`✅ DONE - File saved: ${outputFile}`);
  console.log(`⏱️  Total time: ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
})();
