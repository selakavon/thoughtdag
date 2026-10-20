// Claude Code as a plain answering model: one `claude -p` process per
// request, spoken to in stream-json both ways, wrapped as an AI SDK language
// model so the proxy's generation routes treat it like any other provider.
// The person's Claude plan answers through the CLI's own login; no API key
// passes through here. This is NOT the desktop agent runtime (agents/
// claude.cjs): no working-directory edits, no session files, and only the
// tools the operator names (by default the CLI's read-only web pair,
// WebSearch and WebFetch, so the answer can look things up) — the CLI is
// asked for an answer and nothing else.
//
// What the CLI gets: the system prompt REPLACES Claude Code's own (so the
// coding-agent persona never leaks in), the conversation arrives as ONE user
// message (stream-json input takes user turns only, so earlier turns are
// rendered as a transcript ahead of the latest question), images on the
// latest turn ride along as image blocks. Slash commands, settings and
// session persistence are switched off; built-in tools are limited to the
// configured list (pre-approved, since print mode cannot ask), and MCP
// servers come only from an explicit config file: the turn is a stateless
// completion and costs the fewest tokens that way. Each tool call the CLI
// makes is reported on the reasoning channel as a one-line note.
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { locate, childEnv } = require('./agents/where.cjs');

/** The browser-door address a provider entry carries instead of an HTTP base URL. */
export const CLAUDE_PRINT_URL = 'claude-code://local';
export const isClaudePrintURL = (u) => /^claude-code:/i.test(String(u ?? ''));

/** Model families as the CLI aliases them (each resolves to the newest
 *  model of its family inside the CLI, so the list never goes stale). A
 *  full model name after the namespace is passed through verbatim. */
export const CLAUDE_PRINT_MODELS = [
  { id: 'claude-code/opus', name: 'Opus', vision: true },
  { id: 'claude-code/sonnet', name: 'Sonnet', vision: true },
  { id: 'claude-code/haiku', name: 'Haiku', vision: true },
  { id: 'claude-code/fable', name: 'Fable', vision: true },
];

const EXTRA_HOMES = [path.join(os.homedir(), '.claude', 'local')]; // the CLI's own install location
const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** Where the claude binary is: `CLAUDE_CODE_BIN` when set (a path, or a
 *  name looked up the usual way), else the PATH walk shared with the
 *  desktop agent runtime. `{ path, searched }`, path null when nowhere. */
export async function locateClaude() {
  const configured = String(process.env.CLAUDE_CODE_BIN ?? '').trim();
  if (configured && (configured.includes('/') || configured.includes('\\'))) {
    return isExecutable(configured) ? { path: configured, searched: [configured] } : { path: null, searched: [configured] };
  }
  return locate(configured || 'claude', EXTRA_HOMES);
}

/** What the CLI says about its login (`claude auth status --json`):
 *  `{ loggedIn, authMethod, subscriptionType, … }`, or null when the CLI
 *  predates the command or did not answer in time. `env` overrides apply
 *  as in createClaudePrint, so the answer is for the same setup a turn runs in. */
export function claudeAuthStatus(bin, env = {}) {
  return new Promise((resolve) => {
    const e = { ...childEnv(EXTRA_HOMES) };
    delete e.CLAUDECODE;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete e[k]; else e[k] = String(v); }
    execFile(bin, ['auth', 'status', '--json'], { env: e, timeout: 10000, maxBuffer: 1 << 16 }, (_err, stdout) => {
      try { const o = JSON.parse(String(stdout || '')); resolve(o && typeof o === 'object' && typeof o.loggedIn === 'boolean' ? o : null); } catch { resolve(null); }
    });
  });
}

// ── prompt flattening ─────────────────────────────────────────────

const toBase64 = (data) => {
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  const s = String(data ?? '');
  const m = /^data:[^;]+;base64,(.*)$/s.exec(s);
  return m ? m[1] : s;
};

/** An AI SDK file part as a CLI image block, or null when it is not an
 *  inline image (URLs and documents are not sent; the transcript notes them). */
function imageBlock(part) {
  const mediaType = String(part.mediaType ?? '');
  if (!mediaType.startsWith('image')) return null;
  // v4 tags the data ({ type: 'data' | 'url' | ... }); older shapes are the bare bytes/string
  const d = part.data;
  const raw = d && typeof d === 'object' && !(d instanceof Uint8Array) && !(d instanceof URL) ? (d.type === 'data' ? d.data : null) : d;
  if (raw == null || raw instanceof URL) return null;
  return { type: 'image', source: { type: 'base64', media_type: mediaType === 'image' ? 'image/png' : mediaType, data: toBase64(raw) } };
}

/** The text of a message's parts, with non-text parts noted in brackets. */
function partsText(content) {
  if (typeof content === 'string') return content;
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (p.type === 'text') out.push(p.text);
    else if (p.type === 'file') out.push(String(p.mediaType ?? '').startsWith('image') ? '[image]' : `[file${p.filename ? `: ${p.filename}` : ''}]`);
    // reasoning, tool calls and results never re-enter the prompt
  }
  return out.join('\n');
}

/** The AI SDK prompt as the CLI takes it: `system` (every system message
 *  joined) and `content`, the blocks of one user message. A single user
 *  turn goes through as-is; a longer conversation becomes a transcript of
 *  the earlier turns followed by the latest question, which is the one to
 *  answer. Images on the latest user turn are sent; earlier ones are noted. */
export function flattenPrompt(prompt) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(prompt) ? prompt : []) {
    if (m.role === 'system') { if (m.content) system.push(String(m.content)); continue; }
    if (m.role === 'user' || m.role === 'assistant') turns.push(m);
  }
  let lastUser = -1;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') { lastUser = i; break; }
  const latest = lastUser >= 0 ? turns[lastUser] : null;
  const latestText = latest ? partsText(latest.content) : '';
  const images = [];
  for (const p of latest && Array.isArray(latest.content) ? latest.content : []) {
    if (p.type !== 'file') continue;
    const block = imageBlock(p);
    if (block) images.push(block);
  }
  const earlier = turns.slice(0, Math.max(lastUser, 0));
  let text;
  if (earlier.length === 0) {
    text = latestText;
  } else {
    const lines = earlier.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${partsText(m.content)}`);
    text = `[Conversation so far]\n${lines.join('\n\n')}\n\n[Latest user message — answer this one]\n${latestText}`;
  }
  // bracket notes replace images the latest turn carries; the blocks follow
  const textBlock = { type: 'text', text: images.length > 0 ? text.replace(/\n?\[image\]/g, '') : text };
  return { system: system.join('\n\n'), content: [textBlock, ...images] };
}

// ── the model ─────────────────────────────────────────────────────

const EMPTY_USAGE = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };

function usageOf(u) {
  if (!u || typeof u !== 'object') return EMPTY_USAGE;
  const n = (v) => (typeof v === 'number' ? v : undefined);
  const noCache = n(u.input_tokens); const cacheRead = n(u.cache_read_input_tokens); const cacheWrite = n(u.cache_creation_input_tokens);
  const out = n(u.output_tokens); const reasoning = n(u.output_tokens_details?.thinking_tokens);
  return {
    inputTokens: { total: [noCache, cacheRead, cacheWrite].some((x) => x !== undefined) ? (noCache ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined, noCache, cacheRead, cacheWrite },
    outputTokens: { total: out, text: out !== undefined && reasoning !== undefined ? out - reasoning : undefined, reasoning },
    raw: u,
  };
}

const finishOf = (stop) => ({
  unified: stop === 'end_turn' || stop === 'stop_sequence' ? 'stop' : stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'content-filter' : stop === 'tool_use' ? 'tool-calls' : 'other',
  raw: typeof stop === 'string' ? stop : undefined,
});

/** The `reasoning` call option in the CLI's effort words. */
const effortOf = (reasoning) => (reasoning === 'none' || reasoning === 'minimal' ? 'low' : ['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning) ? reasoning : null);

/** The CLI's read-only web pair: enough to look things up, nothing that edits or runs. */
export const DEFAULT_TOOLS = 'WebSearch,WebFetch';

/** Server names in a Claude Code MCP config (a file path or JSON text), for the allow list. */
export function mcpServerNames(config) {
  try {
    const text = /^\s*\{/.test(config) ? config : fs.readFileSync(config, 'utf8');
    return Object.keys(JSON.parse(text).mcpServers ?? {});
  } catch { return []; }
}

/** One line describing a tool call, for the reasoning channel. */
export function toolNote(block) {
  const name = String(block?.name ?? 'tool');
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  if (name === 'WebSearch') return `Searching the web: ${input.query ?? ''}`.trim();
  if (name === 'WebFetch') return `Reading ${input.url ?? ''}`.trim();
  const short = name.replace(/^mcp__.+?__/, '');
  const args = Object.entries(input).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  return `${short}${args ? `: ${args}` : ''}`.slice(0, 200);
}

/**
 * A provider factory: `createClaudePrint(options)('claude-code/opus')` is a
 * language model (AI SDK spec v4). Options:
 *   bin     — the binary path, or a function returning it (default: locateClaude)
 *   env     — overrides on the child's environment; an undefined value deletes the variable
 *   cwd     — the working directory the CLI runs in (default: the OS temp dir — never a project)
 *   tools   — the CLI's `--tools` value (default 'WebSearch,WebFetch'; '' = none); the listed
 *             tools are also pre-approved. A request's providerOptions['claude-code'].tools
 *             (a string) overrides it for that turn ('' switches the web off).
 *   mcpConfig — a Claude Code MCP config file (path or JSON text) whose servers are offered
 *             and pre-approved whenever tools are on (e.g. a browser-automation server)
 *   effort  — a default effort level; a request's providerOptions['claude-code'].effort or `reasoning` wins
 *   idleMs  — stop a CLI that has been silent this long (default 10 min)
 *   extraArgs — appended verbatim (an escape hatch for CLI flags not modelled here)
 */
export function createClaudePrint(options = {}) {
  const binOf = typeof options.bin === 'function' ? options.bin : options.bin ? async () => options.bin : async () => (await locateClaude()).path;
  const cwd = options.cwd || os.tmpdir();
  const tools = options.tools ?? DEFAULT_TOOLS;
  const mcpConfig = options.mcpConfig ? String(options.mcpConfig) : '';
  const mcpServers = mcpConfig ? mcpServerNames(mcpConfig) : [];
  const idleMs = Number(options.idleMs) > 0 ? Number(options.idleMs) : 10 * 60 * 1000;
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : [];
  const envFor = () => {
    const env = { ...childEnv(EXTRA_HOMES) };
    // a server started from inside a Claude Code session carries its
    // nesting marker; the child is a fresh CLI and must not inherit it
    delete env.CLAUDECODE;
    for (const [k, v] of Object.entries(options.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = String(v); }
    return env;
  };

  const run = (callOptions, onPart) => new Promise((resolve, reject) => {
    void (async () => {
      const bin = await binOf();
      if (!bin || !isExecutable(bin)) throw new Error('claude is not installed: no `claude` found on PATH or in the usual places (set CLAUDE_CODE_BIN to its path)');
      const { system, content } = flattenPrompt(callOptions.prompt);
      const alias = String(callOptions.modelId).replace(/^claude-code\//, '');
      const effort = callOptions.providerOptions?.['claude-code']?.effort ?? effortOf(callOptions.reasoning) ?? options.effort ?? null;
      const turnTools = callOptions.providerOptions?.['claude-code']?.tools;
      const toolList = typeof turnTools === 'string' ? turnTools : tools;
      // print mode cannot ask for permission, so what is offered is also allowed
      const allowed = toolList ? [toolList, ...mcpServers.map((n) => `mcp__${n}`)].join(',') : '';
      // (`--bare` would be leaner still, but it skips the CLI's own login:
      // a plan user gets "Not logged in" — so settings are emptied instead)
      const args = [
        '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
        '--tools', toolList, '--permission-mode', 'default', '--model', alias,
      ];
      if (allowed) args.push('--allowedTools', allowed);
      if (allowed && mcpConfig) args.push('--mcp-config', mcpConfig);
      if (system) args.push('--system-prompt', system);
      if (effort) args.push('--effort', String(effort));
      args.push(...extraArgs);

      const warnings = [];
      if (callOptions.tools?.length) warnings.push({ type: 'unsupported', feature: 'tools', details: 'claude -p runs its own tools only; request tools are dropped' });
      for (const k of ['temperature', 'topP', 'topK', 'stopSequences', 'seed', 'presencePenalty', 'frequencyPenalty']) {
        if (callOptions[k] !== undefined) warnings.push({ type: 'unsupported', feature: k });
      }
      if (callOptions.responseFormat?.type === 'json') warnings.push({ type: 'unsupported', feature: 'responseFormat' });
      onPart({ type: 'stream-start', warnings });

      const proc = spawn(bin, args, { cwd, env: envFor(), stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = ''; let stderr = ''; let settled = false;
      let lastEvent = Date.now();
      let resultSeen = false;
      let usage = EMPTY_USAGE; let stop = undefined;
      const open = new Map(); // content block index → { kind, id }
      let seq = 0; // part ids stay unique across the CLI's turns (indexes restart per message)
      let apiError = null;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        if (callOptions.abortSignal) callOptions.abortSignal.removeEventListener('abort', onAbort);
        if (err) { try { proc.kill(); } catch { /* gone */ } reject(err); }
        else resolve();
      };
      const onAbort = () => {
        const reason = callOptions.abortSignal?.reason;
        finish(reason instanceof Error ? reason : Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (callOptions.abortSignal) {
        if (callOptions.abortSignal.aborted) { try { proc.kill(); } catch { /* not started */ } return onAbort(); }
        callOptions.abortSignal.addEventListener('abort', onAbort, { once: true });
      }
      const watchdog = setInterval(() => {
        if (Date.now() - lastEvent < idleMs) return;
        finish(new Error(`claude produced no activity for ${idleMs >= 60000 ? `${Math.round(idleMs / 60000)} min` : `${Math.round(idleMs / 1000)} s`}; the turn was stopped`));
      }, Math.min(idleMs, 15000));

      const closeBlock = (index) => {
        const b = open.get(index);
        if (!b) return;
        open.delete(index);
        onPart({ type: b.kind === 'thinking' ? 'reasoning-end' : 'text-end', id: b.id });
      };
      const handle = (m) => {
        lastEvent = Date.now();
        switch (m.type) {
          case 'stream_event': {
            const ev = m.event ?? {};
            if (ev.type === 'message_start' && ev.message) {
              onPart({ type: 'response-metadata', ...(ev.message.id ? { id: ev.message.id } : {}), ...(ev.message.model ? { modelId: ev.message.model } : {}) });
            } else if (ev.type === 'content_block_start') {
              const kind = ev.content_block?.type;
              if (kind === 'text' || kind === 'thinking') {
                const id = `${kind}-${seq++}`;
                open.set(ev.index, { kind, id });
                onPart({ type: kind === 'thinking' ? 'reasoning-start' : 'text-start', id });
              }
            } else if (ev.type === 'content_block_delta') {
              const d = ev.delta ?? {};
              const b = open.get(ev.index);
              if (b && d.type === 'text_delta' && d.text) onPart({ type: 'text-delta', id: b.id, delta: d.text });
              else if (b && d.type === 'thinking_delta' && d.thinking) onPart({ type: 'reasoning-delta', id: b.id, delta: d.thinking });
            } else if (ev.type === 'content_block_stop') {
              closeBlock(ev.index);
            } else if (ev.type === 'message_delta') {
              if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
              if (ev.usage) usage = usageOf(ev.usage);
            }
            break;
          }
          case 'assistant': {
            // an API-level failure arrives as a synthetic assistant message; the result repeats it
            if (m.error || m.is_api_error_message) { apiError = m.message?.content?.find?.((b) => b.type === 'text')?.text ?? String(m.error ?? 'API error'); break; }
            // a tool call the CLI made: one line on the reasoning channel, so the person sees what was looked up
            for (const b of m.message?.content ?? []) {
              if (b?.type !== 'tool_use') continue;
              const id = `tool-${seq++}`;
              onPart({ type: 'reasoning-start', id });
              onPart({ type: 'reasoning-delta', id, delta: toolNote(b) });
              onPart({ type: 'reasoning-end', id });
            }
            break;
          }
          case 'result': {
            resultSeen = true;
            for (const index of [...open.keys()]) closeBlock(index);
            if (m.is_error || (m.subtype && m.subtype !== 'success')) {
              const text = typeof m.result === 'string' && m.result ? m.result : apiError ?? String(m.subtype ?? 'error');
              finish(new Error(text));
              break;
            }
            if (m.usage) usage = usageOf(m.usage);
            if (m.stop_reason) stop = m.stop_reason;
            onPart({ type: 'finish', usage, finishReason: finishOf(stop) });
            finish();
            break;
          }
          default: break;
        }
      };

      proc.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (!settled) handle(m);
        }
      });
      proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
      proc.on('error', (e) => finish(new Error(`could not start claude: ${e.message}`)));
      proc.on('exit', (code, signal) => {
        if (settled) return;
        if (resultSeen) return finish();
        const tail = stderr.trim();
        finish(new Error(`claude exited (${signal || `code ${code}`}) before answering${tail ? `: ${tail.slice(-400)}` : ''}`));
      });

      // the whole conversation is one user message; stdin closes right after
      proc.stdin.on('error', () => { /* the CLI went away first; exit reports it */ });
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      proc.stdin.end();
    })().catch(reject);
  });

  return (modelId) => ({
    specificationVersion: 'v4',
    provider: 'claude-code',
    modelId: String(modelId),
    supportedUrls: {},
    async doGenerate(callOptions) {
      const content = []; let finishReason = finishOf(undefined); let usage = EMPTY_USAGE; let warnings = [];
      const response = {};
      const blocks = new Map();
      await run({ ...callOptions, modelId: String(modelId) }, (part) => {
        switch (part.type) {
          case 'stream-start': warnings = part.warnings; break;
          case 'response-metadata': Object.assign(response, part, { type: undefined }); break;
          case 'text-start': case 'reasoning-start': {
            const block = { type: part.type === 'text-start' ? 'text' : 'reasoning', text: '' };
            blocks.set(part.id, block); content.push(block); break;
          }
          case 'text-delta': case 'reasoning-delta': { const b = blocks.get(part.id); if (b) b.text += part.delta; break; }
          case 'finish': finishReason = part.finishReason; usage = part.usage; break;
          default: break;
        }
      });
      delete response.type;
      return { content, finishReason, usage, warnings, response };
    },
    async doStream(callOptions) {
      const stream = new ReadableStream({
        start(controller) {
          run({ ...callOptions, modelId: String(modelId) }, (part) => controller.enqueue(part))
            .then(() => controller.close(), (err) => { try { controller.enqueue({ type: 'error', error: err }); controller.close(); } catch { /* already closed */ } });
        },
      });
      return { stream };
    },
  });
}
