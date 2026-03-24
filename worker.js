// worker.js
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

let translator = null;

self.onmessage = async (e) => {
    const { action, text, modelPath } = e.data;

    // --- LOGIC KIỂM TRA MỚI (CHÍNH XÁC 100%) ---
    if (action === 'check') {
        const cacheNames = await caches.keys();
        let exists = false;
        for (const name of cacheNames) {
            const cache = await caches.open(name);
            const keys = await cache.keys();
            // Kiểm tra trong mọi cache xem có file nào chứa tên model không
            if (keys.some(req => req.url.toLowerCase().includes(modelPath.toLowerCase()))) {
                exists = true;
                break;
            }
        }
        self.postMessage({ status: 'check-result', exists, model: modelPath });
    }

    if (action === 'load') {
        try {
            translator = await pipeline('translation', modelPath, {
                device: 'webgpu',
                // Buộc sử dụng phiên bản nén để tiết kiệm RAM và Disk
                quantized: true, 
                progress_callback: (p) => {
                    self.postMessage({ status: 'progress', progress: p.progress });
                }
            });
            self.postMessage({ status: 'ready', model: modelPath });
        } catch (err) {
            // Nếu WebGPU lỗi, tự động lùi về CPU (WASM)
            translator = await pipeline('translation', modelPath, { quantized: true });
            self.postMessage({ status: 'ready', model: modelPath, device: 'cpu' });
        }
    }

    if (action === 'translate') {
        // ... (Giữ nguyên logic translate cũ của bạn)
        const params = modelPath.includes('nllb') ? { src_lang: 'eng_Latn', tgt_lang: 'vie_Latn' } : {};
        const output = await translator(text, params);
        self.postMessage({ status: 'result', output: output[0].translation_text });
    }
};