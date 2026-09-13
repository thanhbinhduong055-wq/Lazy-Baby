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
    const state = { book: { entries: {} }, saves: 0, generations: 0, chatSaves: 0, cache: new Map(), current: 'chat-A', savedName: '', prompts: [] };
    const ctx = {
        chat: Array.from({ length: 25 }, (_, i) => ({ name: '小雪', is_user: false, is_system: false, mes: `事件${i}` })),
        chatMetadata: options.unbound ? {} : { world_info: '聊天书' },
        characters: [{ avatar: 'alice.png', data: { extensions: { world: options.characterBook || '' } } }], characterId: 0, name2: '小雪', maxContext: 16000,
        extensionSettings: { [core.KEY]: core.settings({ target: 'chat', memoryPrompt: '', autoWrite: false, ...options.settings }) },
        getCurrentChatId: () => state.current, getRequestHeaders: () => ({}),
        getTokenCountAsync: async () => 200,
        generateRaw: async args => { state.generations++; state.prompts.push(args.prompt); return await options.generate?.(ctx, state) || summary; },
        saveWorldInfo: async (name, data) => {
            state.saves++;
            state.savedName = name;
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
    vm.runInNewContext(`${source}\nroot = mockRoot; isolationReady = true; globalThis.api = {
        archive: async () => { await generateDraft(); if (draft) await saveDraft(); },
        generateDraft, saveDraft, restore, updateTokens, clearDraft, refresh,
        cancel: () => { cancelled = true; },
        getDraft: () => draft,
    };`, sandbox);
    node('gm-memoryPrompt').value = ctx.extensionSettings[core.KEY].memoryPrompt;
    return { ctx, state, node, api: sandbox.api };
}

test('自动写入默认开启，显式关闭可保留人工预览模式', () => {
    assert.equal(core.settings().autoWrite, true);
    assert.equal(core.settings({ autoWrite: false }).autoWrite, false);
});
test('自动模式一次生成后直接写入角色书并只隐藏前十五层', async () => {
    const h = host({ characterBook: '角色书', settings: { target: 'character', autoWrite: true } });
    await h.api.generateDraft();
    assert.equal(h.state.generations, 1);
    assert.equal(h.state.saves, 1);
    assert.equal(h.state.savedName, '角色书');
    assert.equal(h.ctx.chat.filter(m => m.is_system).length, 15);
    assert.ok(h.ctx.chat.slice(-10).every(m => !m.is_system));
});
test('自动写入失败保留草稿且不隐藏，不追加模型调用', async () => {
    const h = host({ failSave: true, settings: { autoWrite: true } });
    await h.api.generateDraft();
    assert.equal(h.state.generations, 1);
    assert.equal(h.state.saves, 1);
    assert.equal(h.node('gm-preview').value, summary);
    assert.ok(h.api.getDraft());
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('自动写入可独立关闭自动隐藏', async () => {
    const h = host({ settings: { autoWrite: true, autoHide: false } });
    await h.api.generateDraft();
    assert.equal(h.state.saves, 1);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('重新生成开启自动写入后只保存新生成的草稿', async () => {
    const h = host();
    await h.api.generateDraft();
    h.ctx.extensionSettings[core.KEY].autoWrite = true;
    await h.api.generateDraft(true);
    assert.equal(h.state.generations, 2);
    assert.equal(h.state.saves, 1);
});
test('自动模式生成失败或取消时不保存旧草稿', async () => {
    for (const cancel of [false, true]) {
        const h = host({ generate: async (_ctx, state) => {
            if (state.generations > 1) { if (cancel) h.api.cancel(); else throw new Error('离线'); }
        } });
        await h.api.generateDraft();
        h.ctx.extensionSettings[core.KEY].autoWrite = true;
        await h.api.generateDraft(true);
        assert.equal(h.state.saves, 0);
        assert.ok(h.ctx.chat.every(m => !m.is_system));
    }
});
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

test('生成后只展示可编辑草稿，不创建条目或隐藏消息', async () => {
    const h = host();
    await h.api.generateDraft();
    assert.equal(h.node('gm-preview').value, summary);
    assert.equal(h.state.saves, 0);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
    assert.equal(h.node('gm-save').disabled, false);
});
test('角色世界书：确认后保存编辑过的正文、名称和短提示词', async () => {
    const h = host({ characterBook: '小雪设定书', settings: { target: 'character' } });
    await h.api.generateDraft();
    h.node('gm-preview').value = '玩家修订：小雪目前在旅店，正在等同伴。';
    h.node('gm-title').value = '旅店回忆';
    h.node('gm-memoryPrompt').value = '保持剧情连续，不重复旧事。';
    await h.api.saveDraft();
    assert.equal(h.state.savedName, '小雪设定书');
    assert.equal(h.ctx.chatMetadata.world_info, '聊天书');
    assert.equal(h.state.book.entries[0].comment, '旅店回忆');
    assert.equal(h.state.book.entries[0].content, '保持剧情连续，不重复旧事。\n\n玩家修订：小雪目前在旅店，正在等同伴。');
    assert.equal(h.ctx.chat.filter(m => m.is_system).length, 15);
});
test('角色未绑定世界书时不误写聊天世界书', async () => {
    const h = host({ settings: { target: 'character' } });
    await h.api.generateDraft();
    assert.equal(h.state.generations, 0);
    assert.equal(h.state.saves, 0);
    assert.match(h.node('gm-status').textContent, /未绑定/);
});
test('重新生成使用同一素材和最新总结提示词，成功后替换正文', async () => {
    const h = host({ generate: async (_ctx, state) => summary + `\n版本 ${state.generations}` });
    await h.api.generateDraft();
    const sourceMessages = h.api.getDraft().messages;
    h.node('gm-preview').value = '手动编辑';
    h.ctx.extensionSettings[core.KEY].generationPrompt = '重点记录同伴关系变化';
    await h.api.generateDraft(true);
    assert.equal(h.api.getDraft().messages, sourceMessages);
    assert.match(h.state.prompts[1], /重点记录同伴关系变化/);
    assert.match(h.node('gm-preview').value, /版本 2/);
    assert.equal(h.state.saves, 0);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('重新生成失败保留用户修改过的草稿，并仍可保存', async () => {
    const h = host({ generate: async (_ctx, state) => { if (state.generations > 1) throw new Error('API 离线'); } });
    await h.api.generateDraft();
    h.node('gm-preview').value = '玩家修订后的记忆';
    await h.api.generateDraft(true);
    assert.equal(h.node('gm-preview').value, '玩家修订后的记忆');
    assert.equal(h.node('gm-save').disabled, false);
    await h.api.saveDraft();
    assert.equal(h.state.book.entries[0].content, '玩家修订后的记忆');
});
test('重新生成被取消保留用户草稿', async () => {
    const h = host({ generate: async (_ctx, state) => { if (state.generations > 1) h.api.cancel(); } });
    await h.api.generateDraft();
    h.node('gm-preview').value = '保留这一版';
    await h.api.generateDraft(true);
    assert.equal(h.node('gm-preview').value, '保留这一版');
    assert.equal(h.state.saves, 0);
});
test('编辑后超限或空正文不保存、不隐藏', async () => {
    const h = host();
    await h.api.generateDraft();
    h.node('gm-preview').value = ' ';
    await h.api.saveDraft();
    assert.equal(h.state.saves, 0);
    h.node('gm-preview').value = '长正文';
    h.ctx.getTokenCountAsync = async () => 2000;
    await h.api.saveDraft();
    assert.equal(h.state.saves, 0);
    assert.match(h.node('gm-status').textContent, /超过/);
    assert.ok(h.ctx.chat.every(m => !m.is_system));
});
test('预览后聊天被修改、切换或角色书重绑，拒绝提交旧草稿', async () => {
    for (const action of [h => { h.ctx.chat[0].mes = '改了'; }, h => { h.state.current = 'chat-B'; }, h => { h.ctx.characters[0].data.extensions.world = '另一本书'; }]) {
        const h = host({ characterBook: '角色书', settings: { target: 'character' } });
        await h.api.generateDraft();
        action(h);
        await h.api.saveDraft();
        assert.equal(h.state.saves, 0);
        assert.ok(h.ctx.chat.every(m => !m.is_system));
    }
});
test('预览期间已有回忆在世界书编辑器中变化，不覆盖', async () => {
    const h = host();
    await h.api.archive();
    h.ctx.chat.push({ name: '玩家', mes: '后来', is_user: true });
    await h.api.generateDraft();
    h.state.book.entries[0].content = '其他编辑器修订';
    await h.api.saveDraft();
    assert.equal(h.state.saves, 1);
    assert.equal(h.state.book.entries[0].content, '其他编辑器修订');
});
test('未绑定聊天书时，生成与重新生成均不创建书，确认才创建', async () => {
    const h = host({ unbound: true });
    await h.api.generateDraft();
    await h.api.generateDraft(true);
    assert.equal(h.ctx.chatMetadata.world_info, undefined);
    assert.equal(h.state.saves, 0);
    await h.api.saveDraft();
    assert.equal(h.ctx.chatMetadata.world_info, '新聊天书');
    assert.equal(h.state.saves, 1);
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
