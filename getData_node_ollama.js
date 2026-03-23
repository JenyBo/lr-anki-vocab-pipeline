import fetch from 'node-fetch';
import fs from 'fs';

(async () => {
  const startTime = performance.now();
  console.log("🚀 Start pipeline with Ollama...");
  console.log("📝 Make sure Ollama is running: ollama serve");
  console.log("📝 And you have a model: ollama pull mistral\n");

  // ===== CONFIG =====
  const BATCH_SIZE = 3;
  const BASE_DELAY = 1000;
  const OLLAMA_API = "http://localhost:11434/api/generate";
  const MODEL = "mistral"; // Change to: phi, neural-chat, llama2, etc.

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
    const strongRejections = [
      "không phải là một từ tiếng anh có nghĩa",
      "không phải là từ tiếng anh",
      "không tồn tại trong tiếng anh",
      "lỗi chính tả của",
      "lỗi chính tả",
      "từ giả",
      "đây không phải",
      "đây là một",
      "đây không tồn",
      "not a real english word",
      "not an english word",
      "doesn't exist",
      "typo of",
      "misspelling",
      "fake word",
    ];
    
    return strongRejections.some(pattern => usageLower.includes(pattern));
  }

  // ===== OLLAMA API =====
  async function getMeaning(word) {
    try {
      const prompt = `Provide a brief Vietnamese translation/definition of the English word "${word}". 
Only return the definition, nothing else. If the word doesn't exist, say so clearly.`;

      const response = await fetch(OLLAMA_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          prompt: prompt,
          stream: false,
          temperature: 0.3,
        }),
      });

      if (!response.ok) return "";
      
      const data = await response.json();
      const meaning = data?.response?.trim() || "";
      
      if (!meaning || meaning.length < 5) {
        return "";
      }
      
      return meaning;
    } catch (e) {
      console.log(`  ⚠️  Error getting meaning: ${e.message}`);
      return "";
    }
  }

  async function getUsageBatch(words, retry = 0) {
    const prompt = `You are a professional English dictionary. 

Task: Check and explain these English words in Vietnamese.

IMPORTANT RULES:
- ONLY return JSON format
- If a word does NOT exist in real English (not a real word, typo, or fake):
  * Set "usage" = "" (empty string)
- If word EXISTS: Provide a 1-sentence Vietnamese explanation of how to use it
- Check words in: dictionary, Google examples, real usage context
- DO NOT accept words not in dictionary (reject fake words, typos like: cartisian, tupil, hoc)

Format:
[{"word":"...","usage":"..."}]

Words to check:
${words.join(", ")}

Return JSON:`;

    try {
      const response = await fetch(OLLAMA_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          prompt: prompt,
          stream: false,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        if (retry < 2) {
          console.log(`  ⏳ Retry batch ${retry + 1}`);
          await sleep(2000 * (retry + 1));
          return getUsageBatch(words, retry + 1);
        }
        return {};
      }

      const data = await response.json();
      const text = cleanLLMOutput(data?.response || "");

      return safeParseJSON(text);
    } catch (e) {
      console.log(`  ⚠️  Error: ${e.message}`);
      if (retry < 2) {
        await sleep(2000 * (retry + 1));
        return getUsageBatch(words, retry + 1);
      }
      return {};
    }
  }

  // ===== EXTRACT WORDS =====
  const raw = [];
  const csvFile = './word_list.txt';

  if (fs.existsSync(csvFile)) {
    const content = fs.readFileSync(csvFile, 'utf-8');
    const words_list = content.split('\n').map(w => w.trim()).filter(w => isValidWord(w));
    raw.push(...words_list);
  } else {
    console.log("⚠️  No word_list.txt found. Please create it with words (one per line)");
    return;
  }

  const words = [...new Set(raw)].slice(0, 50);
  console.log(`📊 Words extracted: ${words.length}\n`);

  // ===== VALIDATE & GET DATA =====
  const validWords = [];
  const rejectedWords = [];
  
  console.log(`📝 Validating and getting meanings/usage...\n`);

  const batches = chunk(words, BATCH_SIZE);
  const output = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    console.log(`📤 Batch ${i + 1}/${batches.length}`, batch);

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
    console.log("\n❌ No valid words found!");
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

  console.log(`\n✅ DONE - File saved: ${outputFile}`);
  console.log(`⏱️  Total time: ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
  console.log(`\n💡 Tips:`);
  console.log(`   - Want faster responses? Use: ollama pull phi`);
  console.log(`   - Better quality? Use: ollama pull mistral or llama2`);
  console.log(`   - To stop Ollama: Ctrl+C in the Ollama terminal`);
})();
