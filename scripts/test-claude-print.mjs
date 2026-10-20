// Claude Code as a plain model (runtime/claude-print.mjs), checked against a
// FAKE `claude` binary: a tiny script that speaks stream-json the way the
// real CLI does and records what it was asked. No login, no tokens spent.
// Usage: `npm run test:claude-print`.
import { streamText, generateText, jsonSchema } from 'ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudePrint, claudeAuthStatus, flattenPrompt, locateClaude, toolNote, mcpServerNames, CLAUDE_PRINT_MODELS, isClaudePrintURL, CLAUDE_PRINT_URL } from '../runtime/claude-print.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-claude-print-'));
const fakeBin = path.join(tmp, 'claude');
const log = path.join(tmp, 'log.json');

// The fake: argv + the stdin message land in a log file; the reply is a
// scripted stream-json session (init → thinking → text → result).
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: mode !== 'notloggedin', authMethod: 'claude.ai', subscriptionType: 'max' }) + '\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const line = stdin.split('\\n').find((l) => l.trim());
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin: line ? JSON.parse(line) : null, pid: process.pid, cwd: process.cwd(), env: { CLAUDECODE: process.env.CLAUDECODE ?? null, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null } }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', tools: [] });
  if (mode === 'notloggedin') {
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', is_api_error_message: true });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} });
    return;
  }
  if (mode === 'crash') { process.stderr.write('segfault-ish\\n'); process.exit(3); }
  const ev = (event) => out({ type: 'stream_event', event });
  if (mode === 'tools') {
    // a web search first: a text block, a tool_use block, the tool result, then the answer in a second message
    ev({ type: 'message_start', message: { model: 'claude-opus-5-5', id: 'msg_0' } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check. ' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'WebSearch', input: {} } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"node lts"}' } });
    ev({ type: 'content_block_stop', index: 1 });
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 5, output_tokens: 3 } });
    out({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Let me check. ' }, { type: 'tool_use', id: 'tu_1', name: 'WebSearch', input: { query: 'node lts' } }] } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'v24' }] } });
  }
  ev({ type: 'message_start', message: { model: 'claude-opus-5-5', id: 'msg_1' } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } });
  ev({ type: 'content_block_stop', index: 0 });
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } });
  ev({ type: 'content_block_stop', index: 1 });
  ev({ type: 'message_delta', delta: { stop_reason: mode === 'long' ? 'max_tokens' : 'end_turn' }, usage: { input_tokens: 12, output_tokens: 7 } });
  out({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hello world' }] } });
  if (mode === 'error') { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', usage: {} }); return; }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', stop_reason: mode === 'long' ? 'max_tokens' : 'end_turn', usage: { input_tokens: 12, cache_creation_input_tokens: 600, cache_read_input_tokens: 40, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } } });
});
`);
fs.chmodSync(fakeBin, 0o755);

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); if (!ok) failed++; };
const readLog = () => JSON.parse(fs.readFileSync(log, 'utf8'));
const png = Buffer.from('89504e470d0a1a0a', 'hex');

// ── flattenPrompt: the wire prompt becomes one system string + one user message ──
{
  const single = flattenPrompt([
    { role: 'system', content: 'Be brief.' },
    { role: 'system', content: 'Answer in French.' },
    { role: 'user', content: [{ type: 'text', text: 'Hi there' }] },
  ]);
  check('single turn: system prompts join, the question goes through as-is', single.system === 'Be brief.\n\nAnswer in French.' && single.content.length === 1 && single.content[0].text === 'Hi there');

  const multi = flattenPrompt([
    { role: 'system', content: 'Sys' },
    { role: 'user', content: [{ type: 'text', text: 'Q1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A1' }, { type: 'reasoning', text: 'secret' }] },
    { role: 'user', content: [{ type: 'text', text: 'Q2' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } }] },
  ]);
  const text = multi.content[0].text;
  check('multi turn: earlier turns are rendered as a transcript before the latest question', text.includes('Q1') && text.includes('A1') && text.indexOf('A1') < text.indexOf('Q2') && !text.includes('secret'), text);
  check('multi turn: the latest question is marked as the one to answer', /latest|current|answer/i.test(text) && text.trimEnd().endsWith('Q2'), text.slice(-80));
  check('images on the latest user message become image blocks (bytes → base64)', multi.content.length === 2 && multi.content[1].type === 'image' && multi.content[1].source.media_type === 'image/png' && multi.content[1].source.data === png.toString('base64'));

  const b64 = flattenPrompt([{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'QUJD' } }] }]);
  check('a base64 string rides through untouched', b64.content[1].source.data === 'QUJD');
  const earlyImage = flattenPrompt([
    { role: 'user', content: [{ type: 'text', text: 'Q1' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
    { role: 'user', content: [{ type: 'text', text: 'Q2' }] },
  ]);
  check('an image on an EARLIER turn is noted in the transcript, not sent', earlyImage.content.length === 1 && earlyImage.content[0].text.includes('[image]'));
}

// ── the model over the fake binary ──
const provider = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-from-shell' }, cwd: tmp });

{
  const result = streamText({
    model: provider('claude-code/opus'),
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'Say hi' }],
    providerOptions: { 'claude-code': { effort: 'low' } },
  });
  let text = ''; let reasoning = ''; let finish = null; let usage = null;
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text;
    else if (part.type === 'reasoning-delta') reasoning += part.text;
    else if (part.type === 'finish') { finish = part.finishReason; usage = part.totalUsage; }
    else if (part.type === 'error') throw part.error;
  }
  check('streamText: text deltas arrive in order', text === 'Hello world', JSON.stringify(text));
  check('streamText: thinking arrives on the reasoning channel', reasoning === 'pondering', JSON.stringify(reasoning));
  check('streamText: finish reason stop', finish === 'stop', String(finish));
  check('streamText: usage carries the CLI\'s token counts', usage?.inputTokens === 652 && usage?.outputTokens === 7, JSON.stringify(usage));
  const l = readLog();
  const argAfter = (flag) => l.argv[l.argv.indexOf(flag) + 1];
  check('CLI: print mode with stream-json both ways and partial messages', l.argv.includes('-p') && argAfter('--output-format') === 'stream-json' && argAfter('--input-format') === 'stream-json' && l.argv.includes('--include-partial-messages') && l.argv.includes('--verbose'));
  check('CLI: the model alias is the id without the claude-code/ namespace', argAfter('--model') === 'opus', JSON.stringify(l.argv));
  check('CLI: the system prompt REPLACES Claude Code\'s own (not appended)', argAfter('--system-prompt')?.startsWith('You are terse.') && !l.argv.includes('--append-system-prompt'));
  check('CLI: the read-only web tools by default, pre-approved; no session file, no slash commands, no settings or MCP servers', argAfter('--tools') === 'WebSearch,WebFetch' && argAfter('--allowedTools') === 'WebSearch,WebFetch' && !l.argv.includes('--mcp-config') && l.argv.includes('--no-session-persistence') && l.argv.includes('--disable-slash-commands') && l.argv.includes('--strict-mcp-config') && argAfter('--setting-sources') === '', JSON.stringify(l.argv));
  check('CLI: provider option effort → --effort', argAfter('--effort') === 'low', JSON.stringify(l.argv));
  check('CLI: the question is one stream-json user message', l.stdin?.type === 'user' && l.stdin.message?.content?.[0]?.text === 'Say hi', JSON.stringify(l.stdin));
  check('CLI: runs in the configured working directory', l.cwd === tmp, l.cwd);
  check('CLI: the nesting marker and the API key handed in as env overrides reach the child', l.env.CLAUDECODE === '1' && l.env.ANTHROPIC_API_KEY === 'sk-from-shell', JSON.stringify(l.env));
}

{
  // env overrides: an undefined value DELETES the variable from the child
  const scrub = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, CLAUDECODE: undefined, ANTHROPIC_API_KEY: undefined } });
  process.env.CLAUDECODE = '1'; process.env.ANTHROPIC_API_KEY = 'sk-dotenv';
  await generateText({ model: scrub('claude-code/sonnet'), prompt: 'x' });
  delete process.env.CLAUDECODE; delete process.env.ANTHROPIC_API_KEY;
  const l = readLog();
  check('env: undefined overrides remove the nesting marker and the API key from the child', l.env.CLAUDECODE === null && l.env.ANTHROPIC_API_KEY === null, JSON.stringify(l.env));
}

{
  const { text, finishReason, usage } = await generateText({ model: provider('claude-code/sonnet'), prompt: 'Say hi' });
  check('generateText: the whole answer', text === 'Hello world' && finishReason === 'stop' && usage.outputTokens === 7, `${text} ${finishReason}`);
  check('generateText: default effort is left to the CLI (no --effort)', !readLog().argv.includes('--effort'));
}

{
  const r = await generateText({ model: provider('claude-code/sonnet'), prompt: 'Say hi', providerOptions: { 'claude-code': { effort: 'xhigh' } } });
  check('generateText: effort xhigh forwarded', readLog().argv.includes('xhigh') && r.text === 'Hello world');
}

{
  // the full model name goes through as given; an image in the request becomes an image block
  await generateText({ model: provider('claude-code/claude-opus-5-5'), messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', data: png, mediaType: 'image/png' }] }] });
  const l = readLog();
  check('a full model name is passed verbatim', l.argv[l.argv.indexOf('--model') + 1] === 'claude-opus-5-5');
  check('an image attachment reaches the CLI as a base64 image block', l.stdin.message.content.some((b) => b.type === 'image' && b.source?.data === png.toString('base64')), JSON.stringify(l.stdin.message.content).slice(0, 200));
}

{
  const long = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'long' } });
  const { finishReason } = await generateText({ model: long('claude-code/opus'), prompt: 'x' });
  check('max_tokens maps to finish reason length', finishReason === 'length', finishReason);
}

{
  const bad = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'error' } });
  let err = null;
  try { await generateText({ model: bad('claude-code/opus'), prompt: 'x' }); } catch (e) { err = e; }
  check('an error result surfaces as a thrown error carrying the CLI\'s message', /boom/.test(String(err?.message)), String(err?.message));
}

{
  const nl = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'notloggedin' } });
  let err = null;
  try { await generateText({ model: nl('claude-code/opus'), prompt: 'x' }); } catch (e) { err = e; }
  check('"not logged in" surfaces as the CLI\'s own message', /Not logged in/.test(String(err?.message)), String(err?.message));
}

{
  const crash = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'crash' } });
  let err = null;
  try { await generateText({ model: crash('claude-code/opus'), prompt: 'x' }); } catch (e) { err = e; }
  check('a crash without a result surfaces as an error naming the exit and stderr', /exit|3/.test(String(err?.message)) && /segfault/.test(String(err?.message)), String(err?.message));
}

{
  const missing = createClaudePrint({ bin: path.join(tmp, 'nope') });
  let err = null;
  try { await generateText({ model: missing('claude-code/opus'), prompt: 'x' }); } catch (e) { err = e; }
  check('a missing binary is a clear error, not a spawn stack', /claude/i.test(String(err?.message)) && /not (found|installed)/i.test(String(err?.message)), String(err?.message));
}

{
  // abort: the CLI process must die with the request
  const hang = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'hang' } });
  const ac = new AbortController();
  const result = streamText({ model: hang('claude-code/opus'), prompt: 'x', abortSignal: ac.signal });
  let text = ''; let aborted = false;
  try {
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') { text += part.text; ac.abort(); }
      if (part.type === 'abort') aborted = true;
      if (part.type === 'error') throw part.error;
    }
  } catch (e) { aborted = aborted || e?.name === 'AbortError'; }
  await new Promise((r) => setTimeout(r, 300));
  const { pid } = readLog();
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  check('abort: the stream stops after the first delta and the CLI process is gone', text === 'Hello ' && aborted && !alive, `text=${JSON.stringify(text)} aborted=${aborted} alive=${alive}`);
}

{
  // idle watchdog: a silent CLI is stopped, not waited on forever
  const hang = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'hang' }, idleMs: 400 });
  let err = null;
  const t0 = Date.now();
  try { await generateText({ model: hang('claude-code/opus'), prompt: 'x' }); } catch (e) { err = e; }
  check('a CLI that goes silent is stopped by the idle watchdog', /no activity|idle|silent/i.test(String(err?.message)) && Date.now() - t0 < 5000, String(err?.message));
}

{
  // the CLI's own tools: a search turn streams a note on the reasoning channel, ids stay unique across messages
  const tooled = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: 'tools' } });
  const result = streamText({ model: tooled('claude-code/opus'), prompt: 'Node LTS?' });
  let text = ''; const reasoning = []; const ids = new Set(); let dup = false;
  for await (const part of result.fullStream) {
    if (part.type === 'text-start') { if (ids.has(part.id)) dup = true; ids.add(part.id); }
    else if (part.type === 'text-delta') text += part.text;
    else if (part.type === 'reasoning-delta') reasoning.push(part.text);
    else if (part.type === 'error') throw part.error;
  }
  check('tools: text from both CLI turns arrives, with distinct block ids', text === 'Let me check. Hello world' && !dup, `text=${JSON.stringify(text)} dup=${dup}`);
  check('tools: the search is reported as a one-line note on the reasoning channel', reasoning.some((r) => r === 'Searching the web: node lts'), JSON.stringify(reasoning));
}

{
  // the operator's tool list and an MCP config reach the CLI, both pre-approved; '' for a turn switches everything off
  const mcp = path.join(tmp, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: { command: 'x' } } }));
  const custom = createClaudePrint({ bin: fakeBin, env: { FAKE_CLAUDE_LOG: log }, tools: 'WebFetch', mcpConfig: mcp });
  await generateText({ model: custom('claude-code/opus'), prompt: 'x' });
  let l = readLog(); let argAfter = (flag) => l.argv[l.argv.indexOf(flag) + 1];
  check('tools: the configured list is offered and allowed, MCP servers allowed by name, the config passed', argAfter('--tools') === 'WebFetch' && argAfter('--allowedTools') === 'WebFetch,mcp__browser' && argAfter('--mcp-config') === mcp, JSON.stringify(l.argv));
  await generateText({ model: custom('claude-code/opus'), prompt: 'x', providerOptions: { 'claude-code': { tools: '' } } });
  l = readLog();
  check('tools: a turn with tools \'\' runs with no tools, no allow list and no MCP config', argAfter('--tools') === '' && !l.argv.includes('--allowedTools') && !l.argv.includes('--mcp-config'), JSON.stringify(l.argv));
  check('toolNote: web tools read naturally, MCP tools by their short name', toolNote({ name: 'WebFetch', input: { url: 'https://a.b' } }) === 'Reading https://a.b' && toolNote({ name: 'mcp__browser__browser_navigate', input: { url: 'https://a.b' } }) === 'browser_navigate: url=https://a.b');
  check('mcpServerNames: a path or JSON text, [] when unreadable', mcpServerNames(mcp).join() === 'browser' && mcpServerNames('{"mcpServers":{"a":{},"b":{}}}').join() === 'a,b' && mcpServerNames('/nope.json').length === 0);
}

{
  // tools in the request are refused loudly (the CLI cannot run ours)
  const r = await generateText({ model: provider('claude-code/opus'), prompt: 'x', tools: { ping: { description: 'p', inputSchema: jsonSchema({ type: 'object', properties: {} }) } } });
  check('request tools are dropped with a warning', r.warnings?.some((w) => w.type === 'unsupported' && /tool/i.test(w.feature)), JSON.stringify(r.warnings));
}

// ── login status, binary lookup and the browser-door constants ──
{
  const yes = await claudeAuthStatus(fakeBin, {});
  const no = await claudeAuthStatus(fakeBin, { FAKE_CLAUDE_MODE: 'notloggedin' });
  check('auth status: the CLI\'s own answer, parsed', yes?.loggedIn === true && yes.subscriptionType === 'max' && no?.loggedIn === false, JSON.stringify({ yes, no }));
  const none = await claudeAuthStatus(path.join(tmp, 'nope'), {});
  check('auth status: an unanswerable CLI is null, not a throw', none === null);
}
{
  process.env.CLAUDE_CODE_BIN = fakeBin;
  const found = await locateClaude();
  delete process.env.CLAUDE_CODE_BIN;
  check('CLAUDE_CODE_BIN points the lookup at a specific binary', found.path === fakeBin, JSON.stringify(found));
  process.env.CLAUDE_CODE_BIN = path.join(tmp, 'missing-claude');
  const gone = await locateClaude();
  delete process.env.CLAUDE_CODE_BIN;
  check('a wrong CLAUDE_CODE_BIN reports what was searched', gone.path === null && Array.isArray(gone.searched) && gone.searched.some((d) => d.includes('missing-claude')), JSON.stringify(gone));
  check('the catalog names model families with namespaced ids', CLAUDE_PRINT_MODELS.length >= 3 && CLAUDE_PRINT_MODELS.every((m) => m.id.startsWith('claude-code/') && m.name && m.vision === true));
  check('the browser door URL is recognised', isClaudePrintURL(CLAUDE_PRINT_URL) && isClaudePrintURL('claude-code://local/') && !isClaudePrintURL('https://api.openai.com/v1'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
