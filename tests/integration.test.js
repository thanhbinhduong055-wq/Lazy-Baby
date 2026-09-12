import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as core from '../core.js';

const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const summary = core.HEADINGS.map(h => `## ${h}\n${h === '角色表' ? '| 人物 | 身份 | 关系 |\n| --- | --- | --- |\n| 小雪 | 旅人 | 同伴 |' : '未交代'}`).join('\n\n');
function host(options = {}) {
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: id === 'gm-entry' ? 'auto' : '', textContent: '', style: {}, add() {}, replaceChildren() {} });
        return nodes.get(id);
    };
    const state = { book: { entries: {} }, saves: 0, generations: 0, chatSaves: 0, cache: new Map(), current: 'chat-A' };
    const ctx = {
        chat: Array.from({ length: 25 }, (_, i) => ({ name: '小雪', is_user: false, is_system: false, mes: `事件${i}` })),
        chatMetadata: options.unbound ? {} : { world_info: '聊天书' },
        characters: [{ avatar: 'alice.png' }], characterId: 0, name2: '小雪', maxContext: 16000,
        extensionSettings: { [core.KEY]: core.settings(options.settings) },
        getCurrentChatId: () => state.current, getRequestHeaders: () => ({}),
        getTokenCountAsync: async () => 200,
        generateRaw: async () => { state.generations++; await options.generate?.(ctx, state); return summary; },
        saveWorldInfo: async (name, data) => {
            state.saves++;
            state.cache.set(name, data);
            if (!options.failSave) state.book = structuredClone(data);
            await options.afterSave?.(ctx, state);
        },
        saveChat: async () => { state.chatSaves++; },
        executeSlashCommandsWithOptions: async () => { ctx.chatMetadata.world_info = '新聊天书'; return { pipe: '新聊天书' }; },
    };
    const sandbox = {
        ...core, SillyTavern: { getContext: () => ctx }, jQuery() {},
        console: { error() {} }, toastr: { success() {}, error() {} },
        document: { querySelector: () => ({ style: { display: '' }, setAttribute() {} }) },
        Option: function(label, value) { this.label = label; this.value = value; },
        structuredClone, worldInfoCache: state.cache,
        createWorldInfoEntry: (_name, data) => {
            const uid = Object.keys(data.entries).length;
            return data.entries[uid] = { uid, content: '', comment: '' };
        },
        fetch: async () => ({ ok: true, json: async () => structuredClone(state.book) }),
        mockRoot: { querySelector: selector => node(selector.slice(1)), querySelectorAll: () => [] },
    };
    vm.runInNewContext(`${source}\nroot = mockRoot; globalThis.api = { archive, restore };`, sandbox);
    return { ctx, state, node, api: sandbox.api };
}

test('完整按钮流程：生成、写入常驻条目、服务器验证、隐藏前十五层', async () => {
    const h = host();
    await h.api.archive();
    assert.equal(h.state.saves, 1);
    assert.equal(h.state.generations, 1);
    assert.equal(h.ctx.chat.filter(m => m.is_system).length, 15);
    assert.ok(h.ctx.chat.slice(-10).every(m => !m.is_system));
    const entry = h.state.book.entries[0];
    assert.equal(entry.content, summary);
    assert.equal(entry.constant, true);
    assert.equal(entry.ignoreBudget, true);
    assert.equal(entry[core.KEY].coverage.length, 15);
    assert.equal(h.state.cache.size, 0);
});
test('没有世界书时自动创建并绑定后再保存', async () => {
    const h = host({ unbound: true });
    await h.api.archive();
    assert.equal(h.ctx.chatMetadata.world_info, '新聊天书');
    assert.equal(h.state.saves, 1);
    assert.equal(h.ctx.chat.filter(m => m.is_system).length, 15);
});
test('世界书静默保存失败：所有原文保留，错误缓存清除', async () => {
    const h = host({ failSave: true });
    await h.api.archive();
    assert.equal(h.state.saves, 1);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
    assert.equal(h.state.cache.size, 0);
    assert.match(h.node('gm-status').textContent, /回读不一致/);
});
test('生成期间切换聊天不会写入或隐藏', async () => {
    const h = host({ generate: async (_ctx, state) => { state.current = 'chat-B'; } });
    await h.api.archive();
    assert.equal(h.state.saves, 0);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('生成期间切换世界书不会写入或隐藏', async () => {
    const h = host({ generate: async ctx => { ctx.chatMetadata.world_info = '其他书'; } });
    await h.api.archive();
    assert.equal(h.state.saves, 0);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('保存期间切换聊天：保留已写回忆，但不隐藏楼层', async () => {
    const h = host({ afterSave: async (_ctx, state) => { state.current = 'chat-B'; } });
    await h.api.archive();
    assert.equal(h.state.saves, 1);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('关闭自动隐藏：正常生成并保存，原文可见', async () => {
    const h = host({ settings: { autoHide: false } });
    await h.api.archive();
    assert.equal(h.state.saves, 1);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('第二次点击不重复生成；新增两层后更新同一条目', async () => {
    const h = host();
    await h.api.archive();
    await h.api.archive();
    assert.equal(h.state.generations, 1);
    h.ctx.chat.push({ name: '玩家', mes: '后来1', is_user: true }, { name: '小雪', mes: '后来2', is_user: false });
    await h.api.archive();
    assert.equal(h.state.generations, 2);
    assert.equal(Object.keys(h.state.book.entries).length, 1);
    assert.equal(h.ctx.chat.filter(m => m.is_system).length, 17);
});
test('恢复只处理本插件隐藏的楼层', async () => {
    const h = host();
    h.ctx.chat[0].is_system = true;
    await h.api.archive();
    await h.api.restore();
    assert.equal(h.ctx.chat[0].is_system, true);
    assert.ok(h.ctx.chat.slice(1).every(m => !m.is_system));
    assert.equal(h.state.book.entries[0].content, summary);
});
test('新建前必须恢复旧楼层，重建后旧回忆禁用', async () => {
    const h = host();
    await h.api.archive();
    h.node('gm-entry').value = 'new';
    await h.api.archive();
    assert.equal(h.state.generations, 1);
    assert.match(h.node('gm-status').textContent, /先恢复/);
    await h.api.restore();
    h.node('gm-entry').value = 'new';
    await h.api.archive();
    assert.equal(h.state.generations, 2);
    assert.equal(h.state.book.entries[0].disable, true);
    assert.equal(h.state.book.entries[1].disable, false);
});
test('生成期间其他条目修改会被保留', async () => {
    const h = host({ generate: async (_ctx, state) => { state.book.entries[0] = { uid: 0, content: '刚写入的设定', comment: '设定' }; } });
    await h.api.archive();
    assert.equal(h.state.book.entries[0].content, '刚写入的设定');
    assert.equal(h.state.book.entries[1].content, summary);
});
test('多次点击只有一个任务运行', async () => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const h = host({ generate: async () => pending });
    const first = h.api.archive();
    const second = h.api.archive();
    resolve();
    await Promise.all([first, second]);
    assert.equal(h.state.generations, 1);
    assert.equal(h.state.saves, 1);
});
