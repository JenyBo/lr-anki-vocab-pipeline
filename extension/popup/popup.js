import Exporter from 'anki-apkg-export/dist/exporter';
import createTemplate from 'anki-apkg-export/dist/template';
import SQL from 'sql.js';
import { Buffer } from 'buffer';

// `anki-apkg-export` uses `new Buffer(...)` internally when saving the .apkg.
// In a Chrome extension popup, `Buffer` is not defined by default.
globalThis.Buffer = Buffer;

// ===== CONFIG =====
let TOKEN = '';
const BATCH_SIZE = 3;
const BASE_DELAY = 1000;
const AUDIO_LANG = 'en';
const MEANING_CACHE_KEY = 'meaningCacheV1';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_MEANING_CACHE_ENTRIES = 800;
const AUDIO_DB_NAME = 'lrAudioCacheDb';
const AUDIO_DB_VERSION = 1;
const AUDIO_STORE = 'audio';
const MAX_AUDIO_CACHE_ENTRIES = 800;

// ===== DOM REFS =====
const btnExtract = document.getElementById('btnExtract');
const progressDiv = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const statusText = document.getElementById('statusText');
const resultsDiv = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const downloadsEl = document.getElementById('downloads');
const errorDiv = document.getElementById('error');

const tokenStatusText = document.getElementById('tokenStatusText');
const tokenWarning = document.getElementById('tokenWarning');
const tokenInput = document.getElementById('tokenInput');
const btnSaveToken = document.getElementById('btnSaveToken');

const rankModeSelect = document.getElementById('rankMode');
const minRankField = document.getElementById('minRankField');
const maxRankField = document.getElementById('maxRankField');
const rankHelp = document.getElementById('rankHelp');

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

let meaningCache = {};
let cacheFlushTimer = null;
let audioDb = null;

function nowMs() {
  return Date.now();
}

function isFresh(entry) {
  return entry && typeof entry.ts === 'number' && nowMs() - entry.ts <= CACHE_TTL_MS;
}

function pruneCacheObject(obj, maxEntries) {
  const entries = Object.entries(obj);
  if (entries.length <= maxEntries) return obj;
  entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

async function loadCaches() {
  try {
    const stored = await storageGet([MEANING_CACHE_KEY]);
    const mc = stored?.[MEANING_CACHE_KEY];
    meaningCache = (mc && typeof mc === 'object') ? mc : {};
  } catch {
    meaningCache = {};
  }
}

function scheduleCacheFlush() {
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(async () => {
    cacheFlushTimer = null;
    try {
      meaningCache = pruneCacheObject(meaningCache, MAX_MEANING_CACHE_ENTRIES);
      await storageSet({
        [MEANING_CACHE_KEY]: meaningCache,
      });
    } catch {
      // Ignore quota/write errors; app still works without persistence.
    }
  }, 400);
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function migrateLegacyAudioCache() {
  try {
    await storageRemove(['audioCacheV1']);
  } catch {
    // Ignore migration failures.
  }
}

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: 'word' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open audio cache DB'));
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

async function getAudioFromDb(word) {
  if (!audioDb) return null;
  try {
    const tx = audioDb.transaction(AUDIO_STORE, 'readonly');
    const entry = await idbReq(tx.objectStore(AUDIO_STORE).get(word));
    if (!isFresh(entry) || !(entry?.buf instanceof ArrayBuffer)) return null;
    return new Uint8Array(entry.buf);
  } catch {
    return null;
  }
}

async function putAudioToDb(word, bytes) {
  if (!audioDb || !bytes) return;
  try {
    const tx = audioDb.transaction(AUDIO_STORE, 'readwrite');
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    tx.objectStore(AUDIO_STORE).put({ word, ts: nowMs(), buf: copy });
    await idbTxDone(tx);
  } catch {
    // Ignore write failures.
  }
}

async function pruneAudioDb() {
  if (!audioDb) return;
  try {
    const tx = audioDb.transaction(AUDIO_STORE, 'readonly');
    const all = await idbReq(tx.objectStore(AUDIO_STORE).getAll());
    if (!Array.isArray(all) || all.length === 0) return;

    const fresh = all.filter((entry) => isFresh(entry));
    fresh.sort((a, b) => (b?.ts || 0) - (a?.ts || 0));
    const keep = new Set(fresh.slice(0, MAX_AUDIO_CACHE_ENTRIES).map((entry) => entry.word));

    const cleanupTx = audioDb.transaction(AUDIO_STORE, 'readwrite');
    const store = cleanupTx.objectStore(AUDIO_STORE);
    for (const entry of all) {
      if (!keep.has(entry.word)) store.delete(entry.word);
    }
    await idbTxDone(cleanupTx);
  } catch {
    // Ignore prune failures.
  }
}

const cacheInitPromise = (async () => {
  await migrateLegacyAudioCache();
  await loadCaches();
  audioDb = await openAudioDb();
  await pruneAudioDb();
})();

function setTokenStatus(text, tone) {
  if (!tokenStatusText) return;
  tokenStatusText.textContent = text;
  if (tone === 'ok') tokenStatusText.style.color = '#2cb67d';
  else if (tone === 'bad') tokenStatusText.style.color = '#e74c3c';
  else tokenStatusText.style.color = '#aaa';
}

async function loadAndApplyToken() {
  try {
    setTokenStatus('loading...', 'idle');
    const stored = await storageGet(['diocoToken', 'diocoTokenDebug']);
    const t = stored?.diocoToken;
    const debug = stored?.diocoTokenDebug;

    if (typeof t === 'string' && t.length > 20 && t.includes('/')) {
      TOKEN = t;
      tokenWarning?.classList.add('hidden');
      setTokenStatus(`found (len=${t.length})`, 'ok');
    } else {
      TOKEN = '';
      tokenWarning?.classList.remove('hidden');
      const storedLen = typeof t === 'string' ? t.length : 0;
      const reqAttempt = typeof debug?.requestAttempt === 'number' ? debug.requestAttempt : '';
      const lastRequestAt = typeof debug?.lastRequestAt === 'number' ? debug.lastRequestAt : '';
      const foundAt = typeof debug?.lastCapturedAt === 'number' ? debug.lastCapturedAt : '';
      setTokenStatus(
        `missing (storedLen=${storedLen || 0}${
          reqAttempt ? `, requestAttempt=${reqAttempt}` : ''
        }${lastRequestAt ? `, lastRequestAt=${lastRequestAt}` : ''}${
          foundAt ? `, lastCapturedAt=${foundAt}` : ''
        })`,
        'bad'
      );
    }
  } catch {
    TOKEN = '';
    tokenWarning?.classList.remove('hidden');
    setTokenStatus('missing', 'bad');
  }
}

btnSaveToken?.addEventListener('click', async () => {
  const t = tokenInput?.value?.trim() || '';
  if (!t || t.length < 20) {
    showError('Please paste a valid diocoToken.');
    return;
  }
  await storageSet({ diocoToken: t });
  TOKEN = t;
  tokenWarning?.classList.add('hidden');
  setTokenStatus('saved', 'ok');
});

// Load token immediately when popup opens.
loadAndApplyToken();

// If token arrives after the popup is already open, update the UI automatically.
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.diocoToken || changes.diocoTokenDebug) {
      loadAndApplyToken();
    }
  });
}

// ===== UTILS =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function setStatus(text, pct) {
  statusText.textContent = text;
  if (pct !== undefined) progressFill.style.width = `${Math.round(pct)}%`;
}

function showError(msg) {
  errorDiv.textContent = msg;
  errorDiv.classList.remove('hidden');
}

function cleanLLMOutput(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

function mapResult(arr) {
  const result = {};
  for (const item of arr) {
    if (!item.word) continue;
    result[item.word.toLowerCase()] = item.usage || '';
  }
  return result;
}

function safeParseJSON(text) {
  try { return mapResult(JSON.parse(text)); } catch {}
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return mapResult(JSON.parse(match[0]));
  } catch {}
  const result = {};
  const matches = text.match(/\{[\s\S]*?\}/g);
  if (matches) {
    for (const m of matches) {
      try {
        const obj = JSON.parse(m);
        if (obj.word) result[obj.word.toLowerCase()] = obj.usage || '';
      } catch {}
    }
  }
  return result;
}

function isLLMRejection(usage) {
  if (!usage) return false;
  const u = usage.toLowerCase().trim();
  const rejections = [
    'không phải là một từ tiếng anh có nghĩa',
    'không phải là từ tiếng anh',
    'không tồn tại trong tiếng anh',
    'lỗi chính tả của', 'lỗi chính tả',
    'từ giả', 'đây không phải', 'đây là một', 'đây không tồn',
  ];
  return rejections.some((p) => u.includes(p));
}

const TECH_TERMS = new Set([
  'json','java','serialization','deserialization','api','polymorphism',
  'abstraction','encapsulation','inheritance','interface','protocol',
  'algorithm','namespace','decorator','middleware','callback',
  'typescript','javascript','react','node','nodejs','function','class','variable',
]);

function safeMediaFilename(word) {
  return word.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function updateRankUI() {
  const mode = rankModeSelect?.value || 'gte';

  if (mode === 'gte') {
    if (minRankField) minRankField.classList.remove('hidden');
    if (maxRankField) maxRankField.classList.add('hidden');
    if (rankHelp) rankHelp.textContent = 'Select words with rank >= Min Rank.';
  } else if (mode === 'lte') {
    if (minRankField) minRankField.classList.add('hidden');
    if (maxRankField) maxRankField.classList.remove('hidden');
    if (rankHelp) rankHelp.textContent = 'Select words with rank <= Max Rank.';
  } else {
    // range
    if (minRankField) minRankField.classList.remove('hidden');
    if (maxRankField) maxRankField.classList.remove('hidden');
    if (rankHelp) rankHelp.textContent = 'Select words with rank between Min and Max.';
  }
}

if (rankModeSelect) {
  rankModeSelect.addEventListener('change', updateRankUI);
  updateRankUI();
}

// ===== API CALLS =====

async function getMeaning(word) {
  await cacheInitPromise;
  const key = word.toLowerCase();
  const cached = meaningCache[key];
  if (isFresh(cached) && typeof cached.value === 'string') {
    return cached.value;
  }
  try {
    const res = await fetch(
      `https://api-cdn-plus.dioco.io/base_dict_getHoverDict_8?form=${word}&lemma=&sl=en&tl=vi&pos=ANY&pow=n`
    );
    const data = await res.json();
    const meaning = data?.data?.hoverDictEntries?.join(', ') || '';
    meaningCache[key] = { value: meaning, ts: nowMs() };
    scheduleCacheFlush();
    return meaning;
  } catch {
    return '';
  }
}

async function getUsageBatch(words, retry = 0) {
  const prompt = `Bạn là một độc giả từ điển chuyên nghiệp. 

Nhiệm vụ: Kiểm tra và giải thích các từ tiếng Anh sau

QUY TẮC QUAN TRỌNG:
- CHỈ trả về JSON
- Nếu từ KHÔNG tồn tại trong tiếng Anh thực: Đặt "usage" = ""
- Nếu từ TỒN TẠI: Giải thích 1 câu cách dùng trong tiếng Việt
- KHÔNG chấp nhận từ không có trong từ điển

Format:
[{"word":"...","usage":"..."}]

Danh sách từ cần kiểm tra:
${words.join(', ')}

Trả về JSON:`;

  try {
    const res = await fetch('https://api-cdn-plus.dioco.io/base_lexa_generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        promptWithPlaceHolders_translated: prompt,
        contextSentence: '',
        word: words[0],
        userLanguage_G: 'vi',
        studyLanguage_G: 'en',
        diocoToken: TOKEN,
      }),
    });
    if (res.status === 429) throw new Error('RATE_LIMIT');
    const data = await res.json();
    return safeParseJSON(cleanLLMOutput(data?.data?.generation || ''));
  } catch (e) {
    if (retry < 3) {
      await sleep(1500 * (retry + 1));
      return getUsageBatch(words, retry + 1);
    }
    return {};
  }
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getAudioLR(word) {
  await cacheInitPromise;
  const key = word.toLowerCase();
  const cachedBytes = await getAudioFromDb(key);
  if (cachedBytes) {
    return cachedBytes;
  }
  try {
    const res = await fetch(
      `https://api-cdn-plus.dioco.io/base_dict_getDictTTS_3?lang=${AUDIO_LANG}&text=${encodeURIComponent(word)}`
    );
    const data = await res.json();
    const uri = data?.data;
    if (!uri || typeof uri !== 'string') return null;
    const idx = uri.indexOf('base64,');
    if (idx === -1) return null;
    const bytes = base64ToUint8Array(uri.slice(idx + 7));
    await putAudioToDb(key, bytes);
    return bytes;
  } catch { return null; }
}

// ===== CARD HTML =====

function buildFrontHtml(word, audioFilename) {
  const sound = audioFilename
    ? `<div style="font-size:16px;text-align:center;margin-top:6px">[sound:${audioFilename}]</div>`
    : '';
  return `<div style="font-size:28px;text-align:center"><b>${word}</b></div>${sound}`;
}

function buildBackHtml(meaning, usage) {
  return `<div style="font-size:20px"><b>Meaning:</b> ${meaning}</div><br><div style="font-size:16px"><b>Usage:</b> ${usage}</div>`;
}

// ===== EXPORT =====

async function generateApkg(output) {
  const apkg = new Exporter('Language Reactor Vocab', {
    template: createTemplate(),
    sql: SQL,
  });
  const addedMedia = new Set();

  for (const { word, meaning, usage } of output) {
    let audioFilename = `${safeMediaFilename(word)}.mp3`;
    if (!addedMedia.has(audioFilename)) {
      const audioBuf = await getAudioLR(word);
      if (audioBuf) {
        apkg.addMedia(audioFilename, audioBuf);
        addedMedia.add(audioFilename);
      } else {
        audioFilename = null;
      }
    }
    apkg.addCard(
      buildFrontHtml(word, audioFilename),
      buildBackHtml(meaning, usage),
      { tags: ['language_reactor', 'vocab'] }
    );
  }

  const blob = await apkg.save();
  return blob;
}

function generateQuizletBlob(output) {
  const rows = output.map(({ word, meaning, usage }) => `${word}\t${meaning} - ${usage}`);
  return new Blob([rows.join('\n')], { type: 'text/plain;charset=utf-8' });
}

// ===== MAIN PIPELINE =====

async function runPipeline(words) {
  progressDiv.classList.remove('hidden');
  resultsDiv.classList.add('hidden');
  errorDiv.classList.add('hidden');

  const batches = chunk(words, BATCH_SIZE);
  const output = [];
  let processed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    setStatus(`Batch ${i + 1}/${batches.length}: ${batch.join(', ')}`, (processed / words.length) * 80);

    const usageMap = await getUsageBatch(batch);

    for (const word of batch) {
      const usage = usageMap[word] || '';
      const meaning = await getMeaning(word);

      if (isLLMRejection(usage)) { processed++; continue; }

      const hasMeaning = Boolean(meaning);
      const isTech = usage && TECH_TERMS.has(word.toLowerCase());
      if ((hasMeaning && usage) || isTech) {
        output.push({ word, meaning: meaning || '', usage });
      }
      processed++;
    }
    await sleep(BASE_DELAY);
  }

  if (output.length === 0) {
    showError('No valid words found after processing.');
    return;
  }

  setStatus(`Generating Anki deck (${output.length} words + audio)...`, 85);
  const timestamp = new Date().toISOString().split('T')[0];

  const apkgBlob = await generateApkg(output);
  setStatus('Generating Quizlet file...', 95);
  const quizletBlob = generateQuizletBlob(output);

  setStatus('Done!', 100);

  const apkgUrl = URL.createObjectURL(apkgBlob);
  const quizletUrl = URL.createObjectURL(quizletBlob);

  resultsDiv.classList.remove('hidden');
  summaryEl.textContent = `${output.length} words exported (${words.length - output.length} rejected)`;
  downloadsEl.innerHTML = '';

  const aApkg = document.createElement('a');
  aApkg.href = apkgUrl;
  aApkg.download = `anki_vocab_${timestamp}.apkg`;
  aApkg.textContent = 'Download .apkg';
  downloadsEl.appendChild(aApkg);

  const aQuizlet = document.createElement('a');
  aQuizlet.href = quizletUrl;
  aQuizlet.download = `quizlet_vocab_${timestamp}.txt`;
  aQuizlet.textContent = 'Download Quizlet .txt';
  downloadsEl.appendChild(aQuizlet);
}

// ===== BUTTON HANDLER =====

btnExtract.addEventListener('click', async () => {
  btnExtract.disabled = true;
  errorDiv.classList.add('hidden');
  resultsDiv.classList.add('hidden');

  if (!TOKEN) {
    showError('Missing diocoToken. Log in to languagereactor.com once, or paste the token using the field above.');
    tokenWarning?.classList.remove('hidden');
    btnExtract.disabled = false;
    return;
  }

  const rankMode = rankModeSelect?.value || 'gte'; // 'gte' | 'range' | 'lte'
  const minRankInput = document.getElementById('minRank');
  const maxRankInput = document.getElementById('maxRank');

  const minRankVal = parseInt(minRankInput?.value);
  const maxRankVal = parseInt(maxRankInput?.value);

  let minRank = Number.isFinite(minRankVal) ? minRankVal : 8000;
  let maxRank = Number.isFinite(maxRankVal) ? maxRankVal : minRank;

  // For clarity and consistency with content.js matching:
  if (rankMode === 'gte') {
    maxRank = minRank;
  } else if (rankMode === 'lte') {
    minRank = maxRank;
  }

  const maxWords = parseInt(document.getElementById('maxWords').value) || 200;

  try {
    setStatus('Extracting words from Language Reactor...', 0);
    progressDiv.classList.remove('hidden');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url?.includes('youtube.com')) {
      showError('Please open a YouTube video with Language Reactor first.');
      btnExtract.disabled = false;
      return;
    }

    // Programmatically inject content.js to guarantee it's loaded,
    // then send the extraction message.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    } catch (injectErr) {
      console.warn('Injection skipped (may already be loaded):', injectErr);
    }
    await sleep(200);

    let response = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'extract-words',
          rankMode,
          minRank,
          maxRank,
          maxWords,
        });
        break;
      } catch (err) {
        lastErr = err;
        setStatus(`Waiting for content script... (${attempt}/3)`, 1 + attempt);
        await sleep(500 * attempt);
      }
    }

    if (!response) {
      throw lastErr || new Error('Content script not responding. Please refresh the YouTube page and try again.');
    }

    const words = response?.words || [];
    if (words.length === 0) {
      showError('No words found. Make sure Language Reactor subtitles are visible on the page.');
      btnExtract.disabled = false;
      return;
    }

    setStatus(`Found ${words.length} words. Processing...`, 5);
    await runPipeline(words);
  } catch (err) {
    showError(`Error: ${err.message || String(err)}`);
  } finally {
    btnExtract.disabled = false;
  }
});
