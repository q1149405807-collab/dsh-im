// End-to-end flow test for the ZCode-style bound-session mirror: drives the
// real bridge event pipeline (watchHarnessEvents callback → mirror state →
// #sendCard) against mock Feishu SDK calls and asserts the card create/patch
// sequence and final rendering. Runs against the INSTALLED plugin src, the
// same copy the runtime loads (lib is built from it).
import { FeishuHarnessBridge } from 'file:///C:/Users/Bin/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/src/channels/feishu/bridge.mjs';
import { StateStore } from 'file:///C:/Users/Bin/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/src/channels/feishu/state-store.mjs';
import { unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';

const TMP = 'D:\\aiwork\\dsh-im\\.mirror-flow-state.json';
try { unlinkSync(TMP); } catch {}

const store = new StateStore(TMP);
await store.load?.();
await store.setSession('group:oc_mirror', 'sess-mirror');

const creates = [];
const patches = [];
let nextId = 1;
const client = {
  im: {
    v1: {
      message: {
        create: async (req) => {
          creates.push({ params: req.params, card: JSON.parse(req.data.content) });
          return { code: 0, data: { message_id: `om_${nextId}`.replace('om_', 'om') + '_' + nextId++ } };
        },
        patch: async (req) => {
          patches.push(JSON.parse(req.data.content));
          return { code: 0 };
        },
      },
    },
  },
};

let onSessionEvent = null;
const harness = {
  watchHarnessEvents: ({ onSessionEvent: cb }) => {
    onSessionEvent = cb;
    return { dispose() {} };
  },
  workspaceSession: () => null,
};
const status = { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0, streamResponses: 0, streamUpdates: 0, streamFallbacks: 0, streamErrors: 0, boundStreams: 0, ownerNotices: 0 };

new FeishuHarnessBridge({
  client, channel: {}, harness, state: store, status,
  allowedSenderOpenIds: new Set(['*']),
  ownerOpenIds: [],
  botId: 'bot_x', appId: 'cli_x', botOpenId: 'ou_bot',
  signal: new AbortController().signal, logger: console,
});

// Let the constructor's queueMicrotask start the event watcher.
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(typeof onSessionEvent === 'function', 'watcher captured onSessionEvent');

const feed = (seq, type, data) => onSessionEvent({ sessionId: 'sess-mirror', event: { seq, type, data } });

// Turn 1: Feishu-originated prompt (rpcId "feishu-…", as the ask path sends)
// followed by host-injected context messages. The mirror must NOT open a card.
feed(1, 'turn/start', { turn: 1 });
feed(2, 'user/message', { content: [{ type: 'text', text: '嗨' }], source: { kind: 'user', rpcId: 'feishu-7649d78a-4b3e-4331-9d2f-2fc57a6df01e' } });
feed(3, 'user/message', { content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] });
feed(4, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '你好！' } });
feed(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
await new Promise((resolve) => setTimeout(resolve, 600));
assert.equal(creates.length, 0, `Feishu-originated turn must not mirror, got ${creates.length} creates`);

// Turn 2: computer-side prompt (bare-UUID rpcId, no turn field on the event,
// data.content carries the prompt) with an injected no-source message in the
// middle — the mirror must keep streaming through it (frozen-card regression).
feed(10, 'turn/start', { turn: 2 });
feed(11, 'user/message', { content: [{ type: 'text', text: '请继续说 我在测试' }], source: { kind: 'user', rpcId: '07b0b8e1-7271-458b-8d4f-fc10286819cc' } });
feed(12, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: '好的' } });
feed(13, 'user/message', { content: [{ type: 'text', text: '<openviking-context>injected</openviking-context>' }] });
feed(14, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: '，已完成。' } });
feed(15, 'turn/end', { turn: 2, reason: { kind: 'completed' } });

await new Promise((resolve) => setTimeout(resolve, 1200));

// One create, then in-place patches. A short turn that completes within the
// 1s sync window legitimately produces a single finalize patch.
assert.equal(creates.length, 1, `expected exactly one card create, got ${creates.length}`);
assert.equal(patches.length >= 1, true, `expected >=1 patch, got ${patches.length}`);
assert.equal(status.boundStreams, 1, 'boundStreams counted once');

const first = creates[0];
assert.equal(first.card.schema, '2.0');
assert.deepEqual(first.card.config, { wide_screen_mode: true });
assert.equal(first.card.body.elements[0].content, '**请继续说 我在测试**', 'prompt header from data.content');
assert.equal(first.card.body.elements.at(-1).content, '_⏳ 运行中_', 'running footer on create');

const last = patches.at(-1);
const els = last.body.elements;
const textEl = els.find((el) => el.tag === 'markdown' && el.content.includes('好的'));
assert.ok(textEl, 'streamed text present');
assert.ok(els.some((el) => el.content?.includes('，已完成。')), 'post-injection text block present');
assert.equal(els.at(-1).content, '_✅ 已完成_', 'completed footer');

// Turn 3: computer-side prompt with a tool call and result → tool panel.
feed(20, 'turn/start', { turn: 3 });
feed(21, 'user/message', { content: [{ type: 'text', text: '跑一下测试' }], source: { kind: 'user', rpcId: '3340caa0-9611-4c27-ad53-51851146f9e9' } });
feed(22, 'tool/call', { turn: 3, callId: 'c1', name: 'Bash', arguments: { cmd: 'npm test' } });
feed(23, 'tool/result', { turn: 3, callId: 'c1' });
feed(24, 'turn/end', { turn: 3, reason: { kind: 'completed' } });
await new Promise((resolve) => setTimeout(resolve, 800));

assert.equal(creates.length, 2, 'second mirrored turn opens a new card');
assert.equal(creates[1].card.body.elements[0].content, '**跑一下测试**');
const panel = patches.at(-1).body.elements.find((el) => el.tag === 'collapsible_panel');
assert.ok(panel, 'final card has a tool panel');
assert.ok(panel.header.title.content.startsWith('🛠️ 工具摘要 (1)'), panel.header.title.content);
assert.equal(panel.expanded, false, 'panel collapsed after completion');
assert.ok(panel.elements[0].content.includes('完成 · Bash · `npm test`'), panel.elements[0].content);
assert.equal(patches.at(-1).body.elements.at(-1).content, '_✅ 已完成_', 'third card completed');

// Turn 4 on a p2p-bound session with a cold chat cache: the open_id fallback
// must address the create with receive_id_type=open_id.
await store.setSession('p2p:ou_coldstart', 'sess-p2p');
const feedP2p = (seq, type, data) => onSessionEvent({ sessionId: 'sess-p2p', event: { seq, type, data } });
feedP2p(30, 'turn/start', { turn: 9 });
feedP2p(31, 'user/message', { content: [{ type: 'text', text: '冷启动测试' }], source: { kind: 'user', rpcId: 'aaaa1111-0000-0000-0000-000000000000' } });
feedP2p(32, 'turn/end', { turn: 9, reason: { kind: 'completed' } });
await new Promise((resolve) => setTimeout(resolve, 800));
const p2pCreate = creates.at(-1);
assert.equal(p2pCreate.params.receive_id_type, 'open_id', 'p2p fallback uses open_id');
assert.equal(p2pCreate.card.body.elements[0].content, '**冷启动测试**');

try { unlinkSync(TMP); } catch {}
console.log('mirror-flow end-to-end test passed');
