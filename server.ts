import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ProxyChatBody {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  seed?: number;
  stream?: boolean;
  timeoutMs?: number;
}

interface ProxyModelsBody {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface GeminiChatBody {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  timeoutMs?: number;
  seed?: number;
}

interface SupabaseProxyBody {
  supabaseUrl: string;
  supabaseKey: string;
  tableName?: string;
  action: 'test' | 'push' | 'pull';
  payload?: unknown;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function modelDisallowsSamplingParams(modelName: string): boolean {
  const clean = (modelName.trim().toLowerCase().split('/').pop() ?? '').trim();
  return (
    clean === 'o1' ||
    clean.startsWith('o1-') ||
    clean === 'o3' ||
    clean.startsWith('o3-') ||
    clean === 'o4' ||
    clean.startsWith('o4-') ||
    clean === 'gpt-5' ||
    clean.startsWith('gpt-5-') ||
    clean.startsWith('gpt-5.') ||
    clean === 'deepseek-reasoner'
  );
}

function stripUnsupportedParamsOn400(payload: Record<string, unknown>, errorText: string): boolean {
  const lower = errorText.toLowerCase();
  let changed = false;

  const mentionsTemp =
    lower.includes('temperature') ||
    lower.includes('sampling') ||
    (lower.includes('unsupported') && lower.includes('parameter'));
  const mentionsTopP = lower.includes('top_p') || lower.includes('topp');
  const mentionsMaxTokens =
    lower.includes('max_tokens') &&
    (lower.includes('max_completion_tokens') ||
      lower.includes('unsupported') ||
      lower.includes('not supported'));

  if ((mentionsTemp || mentionsTopP) && 'temperature' in payload) {
    delete payload.temperature;
    changed = true;
  }
  if ((mentionsTemp || mentionsTopP) && 'top_p' in payload) {
    delete payload.top_p;
    changed = true;
  }
  if ((mentionsTemp || mentionsTopP) && 'topP' in payload) {
    delete payload.topP;
    changed = true;
  }
  if (mentionsMaxTokens && typeof payload.max_tokens === 'number') {
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
    changed = true;
  }
  return changed;
}

function buildTroubleshootingAdvice(status: number | null, code: string | undefined, baseUrl: string): string {
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
    return `Unable to reach ${baseUrl}. Ensure the server is running and accessible from this host. For local Ollama/LM Studio on your machine, enable "Direct Browser Mode" in Provider Settings.`;
  }
  if (code === 'AbortError' || status === 504 || status === 408) {
    return 'Request timed out before completion. Increase the timeout budget in Configuration (up to 600s for deep reasoning or local models) or test a smaller prompt.';
  }
  if (status === 401 || status === 403) {
    return 'Authentication rejected. Verify your API key or custom Authorization header for this provider.';
  }
  if (status === 404) {
    return `Endpoint or model not found at ${baseUrl}. Confirm the base URL includes /v1 (e.g., https://api.openai.com/v1) and the model ID exists.`;
  }
  if (status === 429) {
    return 'Rate limit exceeded (429). Reduce parallel worker concurrency or wait before retrying.';
  }
  if (status && status >= 500) {
    return `Upstream provider error (HTTP ${status}). Retry the request or check provider status.`;
  }
  return 'Check network connectivity, CORS settings, and provider base URL.';
}

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      timestamp: Date.now(),
    });
  });

  app.post('/api/proxy/models', async (req: Request, res: Response) => {
    const body = req.body as ProxyModelsBody;
    if (!body?.baseUrl) {
      res.status(400).json({ error: 'baseUrl is required' });
      return;
    }

    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), body.timeoutMs ?? 15000);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(body.headers ?? {}),
      };
      if (body.apiKey && !headers['Authorization'] && !headers['authorization']) {
        headers['Authorization'] = `Bearer ${body.apiKey}`;
      }

      const upstream = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const text = await upstream.text();

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: `Upstream returned HTTP ${upstream.status}`,
          details: text.slice(0, 800),
          advice: buildTroubleshootingAdvice(upstream.status, undefined, baseUrl),
        });
        return;
      }

      try {
        const json = JSON.parse(text);
        res.json(json);
      } catch {
        res.status(502).json({
          error: 'Invalid JSON returned from /models endpoint',
          details: text.slice(0, 400),
        });
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const errorObj = err as { name?: string; message?: string; cause?: { code?: string } };
      const code = errorObj?.cause?.code ?? errorObj?.name;
      res.status(502).json({
        error: errorObj?.message ?? 'Failed to fetch models',
        code,
        advice: buildTroubleshootingAdvice(null, code, baseUrl),
      });
    }
  });

  app.post('/api/proxy/chat', async (req: Request, res: Response) => {
    const body = req.body as ProxyChatBody;
    if (!body?.baseUrl || !body?.model || !Array.isArray(body?.messages)) {
      res.status(400).json({ error: 'baseUrl, model, and messages are required' });
      return;
    }

    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 300000, 1000), 600000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    req.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(body.headers ?? {}),
    };
    if (body.apiKey && !headers['Authorization'] && !headers['authorization']) {
      headers['Authorization'] = `Bearer ${body.apiKey}`;
    }

    const disallowSampling = modelDisallowsSamplingParams(body.model);
    const payload: Record<string, unknown> = {
      model: body.model,
      messages: body.messages,
      stream: body.stream !== false,
    };
    if (!disallowSampling && typeof body.temperature === 'number') payload.temperature = body.temperature;
    if (typeof body.maxTokens === 'number' && body.maxTokens > 0) payload.max_tokens = body.maxTokens;
    if (!disallowSampling && typeof body.topP === 'number') payload.top_p = body.topP;
    if (typeof body.seed === 'number') payload.seed = body.seed;
    if (payload.stream) {
      payload.stream_options = { include_usage: true };
    }

    try {
      let upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!upstream.ok && upstream.status === 400) {
        const errorText = await upstream.text();
        if (stripUnsupportedParamsOn400(payload, errorText)) {
          upstream = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } else {
          clearTimeout(timeoutId);
          res.status(upstream.status).json({
            error: `Upstream API error (${upstream.status})`,
            details: errorText.slice(0, 1200),
            advice: buildTroubleshootingAdvice(upstream.status, undefined, baseUrl),
          });
          return;
        }
      }

      if (!upstream.ok) {
        clearTimeout(timeoutId);
        const errorText = await upstream.text();
        res.status(upstream.status).json({
          error: `Upstream API error (${upstream.status})`,
          details: errorText.slice(0, 1200),
          advice: buildTroubleshootingAdvice(upstream.status, undefined, baseUrl),
        });
        return;
      }

      const contentType = upstream.headers.get('content-type') ?? '';
      if (payload.stream && contentType.includes('text/event-stream') && upstream.body) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              res.write(decoder.decode(value, { stream: true }));
            }
          }
          clearTimeout(timeoutId);
          res.end();
        } catch (streamErr: unknown) {
          clearTimeout(timeoutId);
          const errObj = streamErr as { name?: string; message?: string };
          if (!res.writableEnded) {
            const errorEvent = JSON.stringify({
              error: {
                message: errObj?.message ?? 'Stream interrupted',
                code: errObj?.name,
                advice: buildTroubleshootingAdvice(504, errObj?.name, baseUrl),
              },
            });
            res.write(`data: ${errorEvent}\n\n`);
            res.end();
          }
        }
      } else {
        const jsonText = await upstream.text();
        clearTimeout(timeoutId);
        res.setHeader('Content-Type', 'application/json');
        res.send(jsonText);
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const errObj = err as { name?: string; message?: string; cause?: { code?: string } };
      const code = errObj?.cause?.code ?? errObj?.name;
      const status = code === 'AbortError' ? 504 : 502;
      res.status(status).json({
        error: errObj?.message ?? 'Network failure calling upstream LLM API',
        code,
        advice: buildTroubleshootingAdvice(status, code, baseUrl),
      });
    }
  });

  app.post('/api/proxy/endpoint', async (req: Request, res: Response) => {
    const body = req.body as {
      endpointUrl?: string;
      apiKey?: string;
      headers?: Record<string, string>;
      multipart?: boolean;
      fields?: Record<string, string>;
      files?: Array<{ fieldName?: string; name?: string; mimeType?: string; base64Data?: string }>;
      jsonBody?: Record<string, unknown>;
      timeoutMs?: number;
    };

    const targetUrl = body?.endpointUrl?.trim() ?? '';
    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
      res.status(400).json({ error: 'Valid http/https endpointUrl is required' });
      return;
    }

    const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 300000, 1000), 600000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    req.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    const headers: Record<string, string> = {
      ...(body.headers ?? {}),
    };
    if (body.apiKey && !headers['Authorization'] && !headers['authorization']) {
      headers['Authorization'] = `Bearer ${body.apiKey}`;
    }

    let requestInit: RequestInit;
    if (body.multipart) {
      delete headers['Content-Type'];
      delete headers['content-type'];
      const form = new FormData();
      if (body.fields) {
        for (const [k, v] of Object.entries(body.fields)) {
          if (v !== undefined && v !== null) {
            form.append(k, String(v));
          }
        }
      }
      if (Array.isArray(body.files)) {
        for (const f of body.files) {
          if (!f?.base64Data) continue;
          const bytes = Buffer.from(f.base64Data, 'base64');
          const blob = new Blob([bytes], { type: f.mimeType || 'application/octet-stream' });
          form.append(f.fieldName || 'file', blob, f.name || 'upload.bin');
        }
      }
      requestInit = {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      };
    } else {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      requestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(body.jsonBody ?? {}),
        signal: controller.signal,
      };
    }

    try {
      let upstream = await fetch(targetUrl, requestInit);
      if (!upstream.ok && upstream.status === 400 && !body.multipart && body.jsonBody) {
        const errorText = await upstream.text();
        const retryJson: Record<string, unknown> = { ...body.jsonBody };
        if (stripUnsupportedParamsOn400(retryJson, errorText)) {
          upstream = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(retryJson),
            signal: controller.signal,
          });
        } else {
          clearTimeout(timeoutId);
          res.status(upstream.status).json({
            error: `Upstream API error (${upstream.status})`,
            details: errorText.slice(0, 1200),
            advice: buildTroubleshootingAdvice(upstream.status, undefined, targetUrl),
          });
          return;
        }
      }

      if (!upstream.ok) {
        clearTimeout(timeoutId);
        const errorText = await upstream.text();
        res.status(upstream.status).json({
          error: `Upstream API error (${upstream.status})`,
          details: errorText.slice(0, 1200),
          advice: buildTroubleshootingAdvice(upstream.status, undefined, targetUrl),
        });
        return;
      }

      const contentType = upstream.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && upstream.body) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              res.write(decoder.decode(value, { stream: true }));
            }
          }
          clearTimeout(timeoutId);
          res.end();
        } catch (streamErr: unknown) {
          clearTimeout(timeoutId);
          const errObj = streamErr as { name?: string; message?: string };
          if (!res.writableEnded) {
            const errorEvent = JSON.stringify({
              error: {
                message: errObj?.message ?? 'Stream interrupted',
                code: errObj?.name,
                advice: buildTroubleshootingAdvice(504, errObj?.name, targetUrl),
              },
            });
            res.write(`data: ${errorEvent}\n\n`);
            res.end();
          }
        }
      } else if (
        contentType.startsWith('audio/') ||
        contentType.startsWith('image/') ||
        contentType.includes('application/octet-stream')
      ) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        clearTimeout(timeoutId);
        res.json({
          binaryBase64: buf.toString('base64'),
          mimeType: contentType.split(';')[0].trim() || 'application/octet-stream',
          sizeBytes: buf.length,
        });
      } else {
        const bodyText = await upstream.text();
        clearTimeout(timeoutId);
        res.setHeader('Content-Type', contentType || 'application/json; charset=utf-8');
        res.send(bodyText);
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const errObj = err as { name?: string; message?: string; cause?: { code?: string } };
      const code = errObj?.cause?.code ?? errObj?.name;
      const status = code === 'AbortError' ? 504 : 502;
      res.status(status).json({
        error: errObj?.message ?? 'Network failure calling upstream endpoint',
        code,
        advice: buildTroubleshootingAdvice(status, code, targetUrl),
      });
    }
  });

  app.post('/api/gemini/chat', async (req: Request, res: Response) => {
    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured on the server.',
        advice: 'Configure GEMINI_API_KEY in the Secrets panel or select an external OpenAI-compatible provider.',
      });
      return;
    }

    const body = req.body as GeminiChatBody;
    const modelName = body?.model || 'gemini-4-hydrogen';
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const systemMsg = messages.find((m) => m.role === 'system')?.content;
    const userPrompt = messages
      .filter((m) => m.role !== 'system')
      .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
      .join('\n\n');

    const streamMode = body?.stream !== false;
    const config: Record<string, unknown> = {};
    if (systemMsg) config.systemInstruction = systemMsg;
    if (typeof body?.seed === 'number') config.seed = body.seed;

    const timeoutMs = Math.min(Math.max(body?.timeoutMs ?? 300000, 1000), 600000);
    let aborted = false;
    const timeoutId = setTimeout(() => {
      aborted = true;
    }, timeoutMs);

    req.on('close', () => {
      aborted = true;
    });

    try {
      if (streamMode) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const streamResponse = await ai.models.generateContentStream({
          model: modelName,
          contents: userPrompt,
          config: Object.keys(config).length > 0 ? config : undefined,
        });

        let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;

        for await (const chunk of streamResponse) {
          if (aborted || res.writableEnded) break;
          const text = chunk.text ?? '';
          if (chunk.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }
          if (text) {
            const ssePayload = {
              id: `gemini-${Date.now()}`,
              object: 'chat.completion.chunk',
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
          }
        }

        clearTimeout(timeoutId);
        if (!res.writableEnded) {
          if (usageMetadata) {
            const finalUsage = {
              id: `gemini-${Date.now()}`,
              object: 'chat.completion.chunk',
              model: modelName,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: usageMetadata.promptTokenCount ?? 0,
                completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
                total_tokens: usageMetadata.totalTokenCount ?? 0,
              },
            };
            res.write(`data: ${JSON.stringify(finalUsage)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } else {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: userPrompt,
          config: Object.keys(config).length > 0 ? config : undefined,
        });
        clearTimeout(timeoutId);
        res.json({
          id: `gemini-${Date.now()}`,
          object: 'chat.completion',
          model: modelName,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: response.text ?? '' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: response.usageMetadata?.promptTokenCount ?? 0,
            completion_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
            total_tokens: response.usageMetadata?.totalTokenCount ?? 0,
          },
        });
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const errObj = err as { status?: number; message?: string };
      const status = errObj?.status ?? 500;
      const errorPayload = {
        error: errObj?.message ?? 'Gemini generation failed',
        advice:
          status === 404
            ? `Model "${modelName}" was not found. Try gemini-4-hydrogen or gemini-3.1-flash-lite.`
            : status === 429
            ? 'Quota or rate limit reached. Reduce concurrency or switch models.'
            : 'Verify server Gemini configuration or retry.',
      };
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: errorPayload })}\n\n`);
        res.end();
      } else {
        res.status(status).json(errorPayload);
      }
    }
  });

  app.post('/api/supabase/proxy', async (req: Request, res: Response) => {
    const body = req.body as SupabaseProxyBody;
    if (!body?.supabaseUrl || !body?.supabaseKey) {
      res.status(400).json({ error: 'supabaseUrl and supabaseKey are required' });
      return;
    }

    const baseUrl = normalizeBaseUrl(body.supabaseUrl);
    const table = (body.tableName || 'benchmark_runs').replace(/[^a-zA-Z0-9_]/g, '');
    const restEndpoint = `${baseUrl}/rest/v1/${table}`;

    const headers: Record<string, string> = {
      apikey: body.supabaseKey,
      Authorization: `Bearer ${body.supabaseKey}`,
      'Content-Type': 'application/json',
    };

    try {
      if (body.action === 'test') {
        const resp = await fetch(`${restEndpoint}?select=id&limit=1`, { method: 'GET', headers });
        const text = await resp.text();
        res.status(resp.status).json({
          ok: resp.ok,
          status: resp.status,
          message: resp.ok ? `Connected to table "${table}"` : text.slice(0, 400),
        });
        return;
      }

      if (body.action === 'push') {
        const resp = await fetch(restEndpoint, {
          method: 'POST',
          headers: {
            ...headers,
            Prefer: 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify(body.payload),
        });
        const text = await resp.text();
        res.status(resp.status).json({
          ok: resp.ok,
          status: resp.status,
          data: resp.ok ? JSON.parse(text || '[]') : undefined,
          error: resp.ok ? undefined : text.slice(0, 500),
        });
        return;
      }

      if (body.action === 'pull') {
        const resp = await fetch(`${restEndpoint}?select=*&order=created_at.desc&limit=50`, {
          method: 'GET',
          headers,
        });
        const text = await resp.text();
        res.status(resp.status).json({
          ok: resp.ok,
          status: resp.status,
          data: resp.ok ? JSON.parse(text || '[]') : undefined,
          error: resp.ok ? undefined : text.slice(0, 500),
        });
        return;
      }

      res.status(400).json({ error: 'Invalid action' });
    } catch (err: unknown) {
      const errObj = err as { message?: string };
      res.status(502).json({
        ok: false,
        status: 502,
        error: errObj?.message ?? 'Supabase network error',
      });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LLM Benchmark Workbench listening on http://localhost:${PORT}`);
  });
}

startServer();
