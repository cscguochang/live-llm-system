import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, stat, writeFile, readdir, mkdir } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = __dirname;
const PROGRAMS_DIR = path.join(__dirname, 'programs');

// Ensure programs dir exists
try {
  await mkdir(PROGRAMS_DIR, { recursive: true });
} catch {}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function safeJoin(baseDir, reqPathname) {
  const normalized = path.posix.normalize(String(reqPathname || ''));
  const stripped = normalized.replace(/^(\.\.(\/|\\|$))+/, '');
  const decoded = decodeURIComponent(stripped);
  const full = path.join(baseDir, decoded);
  const rel = path.relative(baseDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return full;
}

function writeJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    const b = Buffer.from(c);
    total += b.length;
    if (total > limitBytes) throw new Error('body_too_large');
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw || '{}');
}

function buildResponsesUrl(endpoint) {
  const s = String(endpoint || '').trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return `https://${s.replace(/^\/+/, '')}`;
}

function extractResponsesOutputText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join('');
  }
  return '';
}

const imageStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of imageStore.entries()) {
    if (!v || !v.expiresAt || v.expiresAt <= now) imageStore.delete(id);
  }
}, 60_000).unref?.();

function gzipCompress(buf) {
  return zlib.gzipSync(buf, { level: 6 });
}

function gzipDecompress(buf) {
  return zlib.gunzipSync(buf);
}

function buildAuthHeaders({ resourceId, appId, accessToken }) {
  return {
    'X-Api-Resource-Id': String(resourceId || '').trim() || 'volc.bigasr.sauc.duration',
    'X-Api-Access-Key': String(accessToken || '').trim(),
    'X-Api-App-Key': String(appId || '').trim()
  };
}

function buildHeader({ messageType, flags, serializationType, compressionType }) {
  const versionByte = (0b0001 << 4) | 1;
  const typeByte = (messageType << 4) | flags;
  const serCompByte = (serializationType << 4) | compressionType;
  return Buffer.from([versionByte, typeByte, serCompByte, 0x00]);
}

function buildFullClientRequest(seq, opts) {
  const payload = {
    user: { uid: 'demo_uid' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
      language: opts?.language || 'zh-CN'
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: Boolean(opts?.enableNonstream)
    }
  };

  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
  const compressed = gzipCompress(payloadBytes);

  const header = buildHeader({
    messageType: 0b0001,
    flags: 0b0001,
    serializationType: 0b0001,
    compressionType: 0b0001
  });

  const out = Buffer.alloc(header.length + 4 + 4 + compressed.length);
  let offset = 0;
  header.copy(out, offset);
  offset += header.length;
  out.writeInt32BE(seq, offset);
  offset += 4;
  out.writeUInt32BE(compressed.length, offset);
  offset += 4;
  compressed.copy(out, offset);
  return out;
}

function buildAudioOnlyRequest(seq, audioBytes, isLast) {
  const flags = isLast ? 0b0011 : 0b0001;
  const sentSeq = isLast ? -seq : seq;

  const header = buildHeader({
    messageType: 0b0010,
    flags,
    serializationType: 0b0001,
    compressionType: 0b0001
  });

  const compressed = gzipCompress(audioBytes);
  const out = Buffer.alloc(header.length + 4 + 4 + compressed.length);
  let offset = 0;
  header.copy(out, offset);
  offset += header.length;
  out.writeInt32BE(sentSeq, offset);
  offset += 4;
  out.writeUInt32BE(compressed.length, offset);
  offset += 4;
  compressed.copy(out, offset);
  return out;
}

function parseAsrResponse(msgBuf) {
  const headerSizeWords = msgBuf[0] & 0x0f;
  const messageType = msgBuf[1] >> 4;
  const flags = msgBuf[1] & 0x0f;
  const serialization = msgBuf[2] >> 4;
  const compression = msgBuf[2] & 0x0f;

  let payload = msgBuf.subarray(headerSizeWords * 4);

  const hasSeq = (flags & 0x01) !== 0;
  const isLast = (flags & 0x02) !== 0;
  const hasEvent = (flags & 0x04) !== 0;

  const out = {
    messageType,
    flags,
    serialization,
    compression,
    payloadSequence: null,
    isLastPackage: isLast,
    event: null,
    code: 0,
    payloadMsg: null
  };

  if (hasSeq) {
    out.payloadSequence = payload.readInt32BE(0);
    payload = payload.subarray(4);
  }

  if (hasEvent) {
    out.event = payload.readInt32BE(0);
    payload = payload.subarray(4);
  }

  if (messageType === 0b1001) {
    const payloadSize = payload.readUInt32BE(0);
    payload = payload.subarray(4, 4 + payloadSize);
  } else if (messageType === 0b1111) {
    out.code = payload.readInt32BE(0);
    const payloadSize = payload.readUInt32BE(4);
    payload = payload.subarray(8, 8 + payloadSize);
  }

  if (!payload || payload.length === 0) return out;

  let decompressed = payload;
  if (compression === 0b0001) {
    try {
      decompressed = gzipDecompress(payload);
    } catch {
      return out;
    }
  }

  if (serialization === 0b0001) {
    try {
      out.payloadMsg = JSON.parse(decompressed.toString('utf-8'));
    } catch {
      out.payloadMsg = { raw: decompressed.toString('utf-8') };
    }
  }

  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/images') {
    try {
      const body = await readJsonBody(req, 3 * 1024 * 1024);
      const dataUrl = String(body?.dataUrl || '');
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl);
      if (!m) {
        writeJson(res, 400, { error: 'invalid_data_url' });
        return;
      }
      const contentType = m[1];
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (!buf || buf.length === 0) {
        writeJson(res, 400, { error: 'empty_image' });
        return;
      }
      if (buf.length > 2 * 1024 * 1024) {
        writeJson(res, 413, { error: 'image_too_large' });
        return;
      }
      const id = crypto.randomUUID();
      imageStore.set(id, { buf, contentType, expiresAt: Date.now() + 15 * 60_000 });
      writeJson(res, 200, { ok: true, id, url: `/api/images/${id}` });
    } catch (e) {
      writeJson(res, 500, { error: String(e?.message || e) });
    }
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/images/')) {
    const id = url.pathname.slice('/api/images/'.length).trim();
    const entry = imageStore.get(id);
    if (!entry) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.contentType || 'image/jpeg',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(entry.buf);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ark/responses') {
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const endpoint = String(body?.endpoint || '').trim() || 'https://ark-cn-beijing.bytedance.net/api/v3/responses';
      const model = String(body?.model || '').trim();
      const apiKey = String(body?.apiKey || '').trim();
      const input = Array.isArray(body?.input) ? body.input : null;
      const temperature = typeof body?.temperature === 'number' ? body.temperature : undefined;
      const maxOutputTokens = typeof body?.maxOutputTokens === 'number' ? body.maxOutputTokens : undefined;
      const stream = Boolean(body?.stream);
      const enableDeepThinking = Boolean(body?.enableDeepThinking);
      const deepThinkingEffort = String(body?.deepThinkingEffort || 'high').trim() || 'high';
      const enableWebSearch = Boolean(body?.enableWebSearch);

      if (!model || !apiKey || !input) {
        writeJson(res, 400, { error: 'missing_model_or_apiKey_or_input' });
        return;
      }

      const url2 = buildResponsesUrl(endpoint);
      const logid = crypto.randomUUID();
      const reqBody = { model, input, stream };
      
      // Handle Deep Thinking / Reasoning
      if (enableDeepThinking) {
        // If user explicitly enables deep thinking
        // Note: The upstream API (Volcengine Ark) might not support 'effort' field yet, 
        // or it uses a different field name. Based on error "unknown field 'effort'", we remove it.
        reqBody.thinking = { type: "enabled" };
      } else {
        // Explicitly disable deep thinking
        reqBody.thinking = { type: "disabled" };
      }

      if (typeof temperature === 'number') reqBody.temperature = temperature;
      if (typeof maxOutputTokens === 'number') {
        reqBody.max_output_tokens = maxOutputTokens;
      }

      console.log('[Ark API] Request:', {
        model,
        stream,
        thinking: reqBody.thinking
      });
      if (enableWebSearch) {
        reqBody.tools = [{ type: 'web_search' }];
        reqBody.tool_choice = 'auto';
      }

      const controller = new AbortController();
      req.on('close', () => controller.abort());

      const resp = await fetch(url2, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-TT-LOGID': logid
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      });

      if (stream) {
        if (!resp.ok) {
          const data = await resp.json().catch(() => null);
          const upstreamLogid =
            resp.headers.get('x-tt-logid') ||
            resp.headers.get('x-tt-traceid') ||
            resp.headers.get('x-request-id') ||
            '';
          const msg =
            data?.error?.message ||
            data?.message ||
            (typeof data?.error === 'string' ? data.error : '') ||
            `upstream_http_${resp.status}`;
          console.error('[Ark Stream Error]', msg, upstreamLogid);
          writeJson(res, resp.status, { ok: false, error: msg, logid: upstreamLogid || logid });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        try {
          if (!resp.body) {
            res.end();
            return;
          }
          for await (const chunk of resp.body) {
            if (controller.signal.aborted) break;
            res.write(Buffer.from(chunk));
          }
        } catch (err) {
            console.error('[Stream Pipe Error]', err);
        } finally {
          res.end();
        }
        return;
      }

      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const upstreamLogid =
          resp.headers.get('x-tt-logid') ||
          resp.headers.get('x-tt-traceid') ||
          resp.headers.get('x-request-id') ||
          '';
        const msg =
          data?.error?.message ||
          data?.message ||
          (typeof data?.error === 'string' ? data.error : '') ||
          `upstream_http_${resp.status}`;
        writeJson(res, resp.status, { ok: false, error: msg, logid: upstreamLogid || logid });
        return;
      }

      writeJson(res, 200, { ok: true, text: extractResponsesOutputText(data), raw: data });
    } catch (e) {
      console.error('[Ark API Error]', e);
      writeJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return;
  }

  // -------------------------------------------------------
  // Programs API
  // -------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/programs') {
    try {
      const files = await readdir(PROGRAMS_DIR);
      const list = [];
      for (const f of files) {
        if (f.endsWith('.md')) {
          list.push(f);
        }
      }
      writeJson(res, 200, { files: list });
    } catch (err) {
      console.error(err);
      writeJson(res, 500, { error: 'Failed to list programs' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/programs/')) {
    const filename = decodeURIComponent(url.pathname.slice('/api/programs/'.length));
    if (!filename || filename.includes('..') || filename.includes('/')) {
      writeJson(res, 400, { error: 'Invalid filename' });
      return;
    }
    try {
      const content = await readFile(path.join(PROGRAMS_DIR, filename), 'utf-8');
      writeJson(res, 200, { content });
    } catch (err) {
      writeJson(res, 404, { error: 'Not found' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/programs') {
    try {
      const body = await readJsonBody(req);
      const { filename, content } = body;
      if (!filename || !content) {
        writeJson(res, 400, { error: 'Missing filename or content' });
        return;
      }
      // Sanitize filename
      const safeName = filename.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-\.]/g, '_');
      const finalName = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
      
      await writeFile(path.join(PROGRAMS_DIR, finalName), String(content), 'utf-8');
      writeJson(res, 200, { success: true, filename: finalName });
    } catch (err) {
      console.error(err);
      writeJson(res, 500, { error: 'Failed to save program' });
    }
    return;
  }

  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = safeJoin(PUBLIC_DIR, pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wssAsr = new WebSocketServer({ server, path: '/asr' });
wssAsr.on('connection', (ws) => {
  let upstream = null;
  let upstreamSeq = 1;
  let started = false;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      if (upstream) upstream.close();
    } catch {}
    upstream = null;
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.type === 'start') {
      if (started) return;
      started = true;
      const asrUrl = String(msg?.asrUrl || '').trim() || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
      const resourceId = String(msg?.resourceId || '').trim() || 'volc.bigasr.sauc.duration';
      const appId = String(msg?.appId || '').trim();
      const accessToken = String(msg?.accessToken || '').trim();
      const language = String(msg?.language || '').trim() || 'zh-CN';
      const enableNonstream = Boolean(msg?.enableNonstream);

      if (!appId || !accessToken) {
        ws.send(JSON.stringify({ type: 'asr_error', message: 'missing_appId_or_accessToken' }));
        cleanup();
        return;
      }

      const headers = buildAuthHeaders({ resourceId, appId, accessToken });
      upstream = new WebSocket(asrUrl, {
        headers: {
          ...headers,
          // Origin: 'https://openspeech.bytedance.com', // Remove origin override, let it be default or set to a valid one if needed
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        handshakeTimeout: 15_000
      });

      upstream.on('open', () => {
        try {
          upstream.send(buildFullClientRequest(upstreamSeq, { language, enableNonstream }));
          upstreamSeq += 1;
          ws.send(JSON.stringify({ type: 'asr_ready' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'asr_error', message: String(e?.message || e) }));
          cleanup();
        }
      });

      upstream.on('message', (d, isBin) => {
        if (!isBin) return;
        try {
          const resp = parseAsrResponse(Buffer.from(d));
          ws.send(JSON.stringify({ type: 'asr_upstream', resp }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'asr_error', message: String(e?.message || e) }));
        }
      });

      upstream.on('unexpected-response', (_request, response) => {
        const chunks = [];
        response.on('data', (d) => chunks.push(Buffer.from(d)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8').slice(0, 800);
          const logid = response.headers?.['x-tt-logid'] || response.headers?.['x-tt-logid'.toLowerCase()];
          ws.send(
            JSON.stringify({
              type: 'asr_error',
              message: `Unexpected server response: ${response.statusCode}${logid ? `; x-tt-logid=${logid}` : ''}${
                body ? `; body=${body}` : ''
              }`
            })
          );
          cleanup();
        });
      });

      upstream.on('error', (e) => {
        ws.send(JSON.stringify({ type: 'asr_error', message: String(e?.message || e) }));
        cleanup();
      });

      upstream.on('close', () => {
        try {
          ws.send(JSON.stringify({ type: 'asr_closed' }));
        } catch {}
        cleanup();
      });
      return;
    }

    if (msg.type === 'audio') {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      const pcmBase64 = String(msg?.pcmBase64 || '');
      if (!pcmBase64) return;
      const isLast = Boolean(msg?.isLast);
      try {
        const audioBytes = Buffer.from(pcmBase64, 'base64');
        upstream.send(buildAudioOnlyRequest(upstreamSeq, audioBytes, isLast));
        upstreamSeq += 1;
        if (isLast) {
          try {
            upstream.close();
          } catch {}
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'asr_error', message: String(e?.message || e) }));
        cleanup();
      }
      return;
    }

    if (msg.type === 'stop') {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        cleanup();
        return;
      }
      try {
        upstream.send(buildAudioOnlyRequest(upstreamSeq, Buffer.alloc(0), true));
      } catch {}
      cleanup();
    }
  });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const host = String(process.env.HOST || '::').trim() || '::';
server.listen(port, host, () => {
  console.log(`server http://${host}:${port}`);
});
