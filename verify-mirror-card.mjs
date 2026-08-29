// Smoke test for the ZCode-style bound-session mirror card renderer in
// src/channels/feishu/bridge.mjs. Extracts the pure module-scope helpers and
// asserts payload shape, markdown hard-break handling, and truncation rules.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('./src/channels/feishu/bridge.mjs', import.meta.url)), 'utf8');

// Pull the mirror helper block (constants + pure functions) out of the module.
const start = source.indexOf('/** Flatten a tool/result error payload into a one-line displayable reason. */');
const end = source.indexOf('/** Accept SDK payload fields that may already be objects or JSON strings. */');
assert.ok(start > 0 && end > start, 'mirror helper block not found');
const helpersBlock = source.slice(start, end);

// The pure helpers only depend on t() and nonEmptyText(); stub both as zh identity.
const moduleSrc = `const t = (text, params) => params
  ? text.replace(/\\{(\\w+)\\}/g, (m, name) => Object.hasOwn(params, name) ? String(params[name]) : m)
  : text;
const nonEmptyText = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
${helpersBlock}
return { mirrorCardMarkdown, mirrorArgumentPreview, mirrorToolPanel, mirrorCardPayload, toolResultErrorText };`;
const factory = new Function(moduleSrc);
const { mirrorCardMarkdown, mirrorArgumentPreview, mirrorToolPanel, mirrorCardPayload, toolResultErrorText } = factory();

// 1. Hard line breaks: two trailing spaces outside code fences, none inside.
const md = mirrorCardMarkdown('第一行\n第二行\n```\ncode\nline\n```\n尾行');
const lines = md.split('\n');
assert.equal(lines[0], '第一行  ', 'text line should end with two spaces');
assert.equal(lines[1], '第二行  ', 'text line before fence gets break');
assert.equal(lines[2], '```', 'opening fence untouched');
assert.equal(lines[3], 'code', 'code line untouched');
// ZCode behavior: the closing fence flips inCode back before pushing, so it
// carries a hard break when a non-empty line follows.
assert.equal(lines[5], '```  ', 'closing fence followed by text gets a hard break');
assert.equal(lines[6], '尾行', 'last line gets no break');

// 2. Horizontal rule spacing (blank rows around it already isolate the rule,
// so adjacent text lines need no hard break).
assert.equal(mirrorCardMarkdown('a\n---\nb'), 'a\n\n---\n\nb');

// 3. Argument preview: compacts, middle-truncates, escapes backticks.
const long = 'x'.repeat(200);
const preview = mirrorArgumentPreview({ cmd: long });
assert.ok(preview.includes(' ... '), 'long preview middle-truncates');
assert.ok(preview.length <= 100, `preview bounded, got ${preview.length}`);
assert.equal(mirrorArgumentPreview('has `back`\\tick'), 'has \\`back\\`\\\\tick', 'escapes backticks and backslashes');
assert.equal(mirrorArgumentPreview({}), null);

// 4. Tool result error flattening.
assert.equal(toolResultErrorText({ message: 'boom' }), 'boom');
assert.equal(toolResultErrorText({ name: 'Err', code: 'E1' }), 'Err: E1');
assert.equal(toolResultErrorText(null), null);

// 5. Full payload: header, streamed text, tool panel, status footer.
const entry = {
  blocks: [
    { type: 'message', text: '**帮我跑测试**' },
    { type: 'message', text: '开始执行。' },
    { type: 'tools', callIds: ['c1', 'c2'] },
    { type: 'message', text: '完成。' },
  ],
  toolCalls: new Map([
    ['c1', { name: 'Bash', status: 'completed', preview: 'npm test', error: null }],
    ['c2', { name: 'Edit', status: 'failed', preview: 'a.js', error: 'boom' }],
  ]),
  status: 'running',
};
const payload = mirrorCardPayload(entry);
assert.equal(payload.schema, '2.0');
assert.deepEqual(payload.config, { wide_screen_mode: true });
const els = payload.body.elements;
assert.equal(els.length, 5, 'header + text + panel + text + footer');
assert.equal(els[0].content, '**帮我跑测试**');
assert.equal(els[1].content, '开始执行。');
assert.equal(els[2].tag, 'collapsible_panel');
assert.equal(els[2].expanded, true, 'last tool panel expanded while running');
assert.ok(els[2].header.title.content.startsWith('🛠️ 工具摘要 (2)'));
assert.ok(els[2].elements[0].content.includes('完成 · Bash · `npm test`'), JSON.stringify(els[2].elements[0]));
assert.ok(els[2].elements[0].content.includes('失败 · Edit · `a.js`：boom'));
assert.equal(els[4].content, '_⏳ 运行中_', 'running footer');

// 6. Completed: panels collapse, footer flips.
entry.status = 'completed';
const done = mirrorCardPayload(entry);
assert.equal(done.body.elements[2].expanded, false, 'panels collapse when done');
assert.equal(done.body.elements.at(-1).content, '_✅ 已完成_');

// 7. Failed turn with no text: explicit failure line.
const failedEntry = { blocks: [], toolCalls: new Map(), status: 'failed' };
const failed = mirrorCardPayload(failedEntry);
assert.equal(failed.body.elements[0].content, '正在处理...');
assert.equal(failed.body.elements.at(-1).content, '_失败_');

// 8. Text budget: over-long message blocks are truncated, card stays bounded.
const bigEntry = {
  blocks: [{ type: 'message', text: '字'.repeat(30000) }],
  toolCalls: new Map(),
  status: 'running',
};
const big = mirrorCardPayload(bigEntry);
const serialized = JSON.stringify(big);
assert.ok(serialized.length < 29000, `card payload too large: ${serialized.length}`);
assert.ok(big.body.elements[0].content.endsWith('…'), 'truncated text marked with ellipsis');

console.log('mirror-card smoke test passed');
