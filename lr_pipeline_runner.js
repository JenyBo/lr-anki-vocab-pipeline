import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const DEFAULT_PORT = 4567;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[name] = next;
      i++;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const args = parseArgs(process.argv);
const PORT = toInt(args.port, DEFAULT_PORT);
const MIN_RANK = toInt(args.minRank, 8000);
const MAX_WORDS = toInt(args.maxWords, 200);
const YOUTUBE_URL = args.youtube ? String(args.youtube) : '';

let isRunning = false;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'POST') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Use POST\n');
    return;
  }

  if (req.url !== '/words') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 5_000_000) req.destroy();
  });

  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const words = Array.isArray(parsed.words) ? parsed.words : [];

      if (words.length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No words received\n');
        return;
      }

      if (isRunning) {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Pipeline already running. Try again when it finishes.\n');
        return;
      }

      isRunning = true;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Received ${words.length} words. Export is starting...\n`);

      // Overwrite word_list.txt, then reuse your existing pipeline.
      fs.writeFileSync('./word_list.txt', words.join('\n'), 'utf-8');

      const child = spawn('node', ['getData_node.js'], { stdio: 'inherit' });
      child.on('exit', (code) => {
        isRunning = false;
        console.log(`\n[lr_pipeline_runner] getData_node.js finished with code: ${code}`);
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Invalid request: ${e?.message || String(e)}\n`);
      isRunning = false;
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[lr_pipeline_runner] Server listening on http://127.0.0.1:${PORT}/words`);
  console.log(`[lr_pipeline_runner] Will extract: rank >= ${MIN_RANK}, maxWords=${MAX_WORDS}`);
  if (YOUTUBE_URL) console.log(`[lr_pipeline_runner] youtube=${YOUTUBE_URL}`);

  const encodedYoutube = YOUTUBE_URL.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // One-time copy/paste snippet to run inside the Language Reactor page.
  // It reads `.lln-word` DOM and sends words to our local Node server.
  const snippet = `(async () => {
  const MIN_RANK = ${MIN_RANK};
  const MAX_WORDS = ${MAX_WORDS};
  const PORT = ${PORT};
  const YOUTUBE_URL = '${encodedYoutube}';

  const raw = [];
  document.querySelectorAll("h4").forEach((h4) => {
    const match = h4.innerText.match(/Rank\\s*(\\d+)/);
    if (!match) return;
    const rank = parseInt(match[1]);
    if (rank < MIN_RANK) return;
    const container = h4.nextElementSibling;
    if (!container) return;
    container.querySelectorAll(".lln-word").forEach((w) => {
      const key = w.getAttribute("data-word-key");
      const word = key?.split("|")[1] || w.innerText.trim();
      if (!word) return;
      const cleaned = word.toLowerCase().trim();
      if (!/^[a-zA-Z]{3,}$/.test(cleaned)) return;
      raw.push(cleaned);
    });
  });

  // Fallback: if Language Reactor DOM doesn't expose "Rank", still extract from visible '.lln-word'.
  if (raw.length === 0) {
    document.querySelectorAll(".lln-word").forEach((w) => {
      const key = w.getAttribute("data-word-key");
      const word = key?.split("|")[1] || w.innerText.trim();
      if (!word) return;
      const cleaned = word.toLowerCase().trim();
      if (!/^[a-zA-Z]{3,}$/.test(cleaned)) return;
      raw.push(cleaned);
    });
  }

  const words = [...new Set(raw)].slice(0, MAX_WORDS);
  console.log("[lr_pipeline_runner] extracted words:", words.length);

  const resp = await fetch("http://127.0.0.1:"+PORT+"/words", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words, youtubeUrl: YOUTUBE_URL })
  });
  console.log("[lr_pipeline_runner] server response:", await resp.text());
})();`;

  console.log('\n---');
  console.log('Open the YouTube page in Language Reactor, enable subtitles so vocabulary appears.');
  console.log('Then paste this snippet into the browser console:');
  console.log('\n' + snippet);
  console.log('---\n');
});

