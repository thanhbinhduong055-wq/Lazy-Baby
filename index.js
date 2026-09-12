import { createWorldInfoEntry, worldInfoCache } from '../../../world-info.js';
import { KEY, DEFAULTS, settings, plan, summarize, persistVerified } from './core.js';

const context = () => SillyTavern.getContext();
let busy = false;
let cancelled = false;
let epoch = 0;
let refreshId = 0;
let root;
const $id = id => root.querySelector(`#gm-${id}`);
const identity = ctx => JSON.stringify([ctx.groupId ?? null, ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId ?? null, ctx.getCurrentChatId()]);
const snapshot = ctx => JSON.stringify(ctx.chat.map(m => [m.name, m.is_user, m.is_system, m.mes]));
function status(text) { $id('status').textContent = text; }

async function readBook(name) {
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`读取世界书失败（HTTP ${response.status}）。`);
    const data = await response.json();
    if (!data || typeof data.entries !== 'object' || !data.entries) throw new Error('世界书不存在或结构无效。');
    return data;
}

function toggleBusy(value) {
    busy = value;
    root.querySelectorAll('input, select, button').forEach(node => { node.disabled = value; });
    $id('cancel').disabled = !value;
    $id('cancel').hidden = !value;
}

function preferences() {
    return settings(context().extensionSettings[KEY]);
}

async function refresh() {
    const ticket = ++refreshId;
    const ctx = context();
    const currentIdentity = identity(ctx);
    const name = ctx.chatMetadata.world_info;
    $id('book').textContent = name || '未绑定世界书；首次总结时自动创建并绑定';
    $id('entry').replaceChildren(new Option('自动选择本聊天回忆 / 不存在则创建', 'auto'), new Option('新建独立回忆（重建前先恢复旧楼层）', 'new'));
    if (!name || !ctx.getCurrentChatId()) return;
    try {
        const data = await readBook(name);
        if (ticket !== refreshId || identity(context()) !== currentIdentity) return;
        for (const entry of Object.values(data.entries)) {
            if (entry[KEY]?.owner && entry[KEY].owner !== currentIdentity) continue;
            $id('entry').add(new Option(`${entry.comment || '未命名条目'} · #${entry.uid}`, String(entry.uid)));
        }
    } catch (error) { if (ticket === refreshId) status(error.message); }
}

function selectEntry(data, selection, owner) {
    if (selection === 'new') return null;
    if (selection === 'auto') {
        return Object.values(data.entries).filter(e => e[KEY]?.owner === owner && !e.disable)
            .sort((a, b) => (b[KEY].updated || 0) - (a[KEY].updated || 0))[0] || null;
    }
    const entry = data.entries[selection];
    if (!entry) throw new Error('所选条目已不存在，请刷新条目。');
    if (entry[KEY]?.owner && entry[KEY].owner !== owner) throw new Error('该回忆属于其他聊天，请选择本聊天的条目。');
    return entry;
}

function setHidden(ctx, indices, hidden) {
    // Same persisted flag and DOM attribute used by SillyTavern hideChatMessageRange.
    // Apply synchronously so switching chats cannot partially mutate another chat.
    for (const index of indices) {
        const message = ctx.chat[index];
        message.extra ||= {};
        if (hidden) message.extra[KEY] = { hidden: true };
        else delete message.extra[KEY];
        message.is_system = hidden;
        document.querySelector(`.mes[mesid="${index}"]`)?.setAttribute('is_system', String(hidden));
    }
}

async function archive() {
    if (busy) return;
    const ctx = context();
    if (!ctx.getCurrentChatId()) return status('请先打开一个角色或群聊。');
    if (document.querySelector('#send_but')?.style.display === 'none' || ctx.streamingProcessor && !ctx.streamingProcessor.isFinished) {
        return status('请等待当前回复生成结束。');
    }
    const initialIdentity = identity(ctx);
    const initialSnapshot = snapshot(ctx);
    const initialEpoch = epoch;
    const initialBook = ctx.chatMetadata.world_info;
    let expectedBook = initialBook;
    const options = preferences();
    const selection = $id('entry').value;
    let committed = false;
    const assertCurrent = () => {
        if (cancelled) throw new Error('已取消。');
        const now = context();
        if (epoch !== initialEpoch || identity(now) !== initialIdentity || now.chat !== ctx.chat || snapshot(now) !== initialSnapshot) {
            throw new Error('聊天已切换或内容发生变化，本次不会隐藏楼层，请重试。');
        }
        if (now.chatMetadata.world_info !== expectedBook) throw new Error('世界书绑定已变化，请重试。');
    };
    cancelled = false;
    toggleBusy(true);
    try {
        let bookName = initialBook;
        let data = bookName ? await readBook(bookName) : { entries: {} };
        assertCurrent();
        let entry = selectEntry(data, selection, initialIdentity);
        if (Object.values(data.entries).some(e => e[KEY]?.owner && e[KEY].owner !== initialIdentity && !e.disable)) {
            throw new Error('该世界书含其他聊天的常驻回忆。请在酒馆中为当前聊天绑定独立世界书，避免剧情混入。');
        }
        const oldEntry = entry ? JSON.stringify(entry) : null;
        const coverage = entry?.[KEY]?.coverage || [];
        const known = new Set(coverage.map(x => x.index));
        if (ctx.chat.some((m, i) => m.extra?.[KEY]?.hidden && !known.has(i))) {
            throw new Error('部分隐藏楼层不在所选回忆中。请先恢复插件隐藏楼层，再新建或更换条目。');
        }
        const { messages, end } = await plan(ctx.chat, coverage);
        assertCurrent();
        if (!messages.length && !coverage.length) return status('没有可总结的旧楼层。最近十层会完整保留，手动隐藏的楼层不参与总结。');
        if (!messages.length) return status('没有新增旧楼层需要总结。已恢复的楼层会保持可见；可选择新建回忆重新整理。');
        const memory = await summarize({
            previous: entry?.content || '', messages, options,
            count: text => ctx.getTokenCountAsync(text),
            generate: (prompt, responseLength) => ctx.generateRaw({ prompt, responseLength, trimNames: false }),
            assertCurrent, progress: status, contextLimit: ctx.maxContext,
        });
        const tokens = await ctx.getTokenCountAsync(memory);
        assertCurrent();
        if (!bookName) {
            status('正在创建聊天世界书…');
            const result = await ctx.executeSlashCommandsWithOptions('/getchatbook');
            expectedBook = result?.pipe;
            assertCurrent();
            bookName = result?.pipe;
            if (!bookName || context().chatMetadata.world_info !== bookName) throw new Error('无法创建并绑定聊天世界书。');
        } else if (context().chatMetadata.world_info !== initialBook) {
            throw new Error('世界书绑定已变化，请重试。');
        }
        // Re-read immediately before commit to preserve unrelated changes made while generating.
        data = await readBook(bookName);
        assertCurrent();
        if (entry && JSON.stringify(data.entries[entry.uid]) !== oldEntry) throw new Error('所选回忆在生成期间被修改，本次未覆盖，请重试。');
        if (!entry) {
            entry = createWorldInfoEntry(bookName, data);
            if (!entry) throw new Error('创建世界书条目失败。');
        } else entry = data.entries[entry.uid];
        const newCoverage = [...coverage, ...messages.map(({ index, hash }) => ({ index, hash }))];
        // Keep only one active rolling memory belonging to this chat.
        for (const other of Object.values(data.entries)) {
            if (other.uid !== entry.uid && other[KEY]?.owner === initialIdentity) other.disable = true;
        }
        Object.assign(entry, {
            comment: entry.comment || `回忆 · ${ctx.name2 || '当前聊天'}`,
            content: memory, constant: true, disable: false, selective: false,
            vectorized: false, probability: 100, useProbability: true,
            position: 0, order: 999, ignoreBudget: true,
            excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 0,
            group: '', triggers: [], sticky: 0, cooldown: 0, delay: 0,
            characterFilterNames: [], characterFilterTags: [], characterFilterExclude: false,
            [KEY]: { owner: initialIdentity, updated: Date.now(), coverage: newCoverage },
        });
        status('正在写入并校验世界书…');
        try {
            await persistVerified({
                name: bookName, data, assertCurrent,
                save: (name, value) => ctx.saveWorldInfo(name, value, true), read: readBook,
            });
        } finally {
            // Native save updates cache before HTTP and does not check response.ok.
            // Never retain an unverified cache entry, including on network/readback failure.
            worldInfoCache.delete(bookName);
        }
        committed = true;
        $id('preview').textContent = memory;
        $id('result').open = true;
        // Critical: all asynchronous generation/read/write verification completed before hiding.
        assertCurrent();
        const hidden = options.autoHide ? newCoverage.map(x => x.index).filter(i => i < end && !ctx.chat[i].is_system) : [];
        setHidden(ctx, hidden, true);
        await ctx.saveChat();
        if (identity(context()) === initialIdentity) status(`已写入「${bookName}」→「${entry.comment}」，约 ${tokens} tokens。本次总结 ${messages.length} 层，隐藏 ${hidden.length} 层，保留最近十层。`);
        toastr.success('回忆已保存到世界书', '懒人宝');
    } catch (error) {
        console.error('[懒人宝]', error);
        status(`${error.message}${committed ? ' 回忆已写入世界书。' : ' 如已进入写入阶段，请检查世界书中的回忆；不会继续隐藏楼层。'}`);
    } finally {
        toggleBusy(false);
        await refresh();
    }
}

async function restore() {
    if (busy) return;
    const ctx = context();
    const indices = ctx.chat.flatMap((m, i) => m.extra?.[KEY]?.hidden ? [i] : []);
    if (!indices.length) return status('没有由本插件隐藏的楼层。');
    toggleBusy(true);
    try {
        setHidden(ctx, indices, false);
        await ctx.saveChat();
        status(`已恢复 ${indices.length} 层。世界书回忆仍保留；若需重建，请选择“新建独立回忆”。`);
    } catch (error) { status(error.message); }
    finally { toggleBusy(false); }
}

function init() {
    const ctx = context();
    const required = ['generateRaw', 'getTokenCountAsync', 'saveWorldInfo', 'getCurrentChatId', 'saveChat', 'executeSlashCommandsWithOptions'];
    if (required.some(key => typeof ctx[key] !== 'function')) {
        toastr.error('当前酒馆缺少必需扩展接口，请更新 SillyTavern。', '懒人宝');
        return;
    }
    if (document.getElementById('gufa-memory')) return;
    ctx.extensionSettings[KEY] = settings(ctx.extensionSettings[KEY] || DEFAULTS);
    root = document.createElement('div');
    root.id = 'gufa-memory';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>懒人宝 · 剧情记忆</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="gm-intro"><strong>旧事入册，新章续写</strong><small>合并前文为世界书回忆，保留最近十层对话。</small></div>
                <label>当前聊天世界书<small id="gm-book"></small></label>
                <label>回忆条目<select id="gm-entry" class="text_pole"></select><small>自动使用本聊天的回忆。选择现有条目会把原内容合并为滚动回忆，并改为常驻激活。</small></label>
                <button type="button" id="gm-refresh" class="menu_button">刷新条目</button>
                <label>信息详细程度<select id="gm-detail" class="text_pole"><option value="brief">精简 · 事件与状态</option><option value="standard">标准 · 因果与关系</option><option value="rich">详细 · 动机与伏笔</option></select></label>
                <div class="gm-grid">
                    <label>回忆 Token 上限<input id="gm-maxTokens" class="text_pole" type="number" min="256" max="8000" step="64"></label>
                    <label>每次输入 Token 预算<input id="gm-inputTokens" class="text_pole" type="number" min="1024" max="64000" step="512"></label>
                </div>
                <small>按酒馆当前分词器计数；长聊天自动分批，可能调用模型多次。回忆常驻且不受世界书预算限制，会占用模型上下文。</small>
                <label class="gm-check"><input id="gm-autoHide" type="checkbox">写入成功后自动隐藏已总结楼层</label>
                <div class="gm-actions">
                    <button type="button" id="gm-run" class="menu_button gm-primary">总结前文并写入回忆</button>
                    <button type="button" id="gm-restore" class="menu_button">恢复插件隐藏楼层</button>
                    <button type="button" id="gm-cancel" class="menu_button" hidden>取消后续处理</button>
                </div>
                <p id="gm-status" role="status" aria-live="polite">请连接模型并打开聊天。每条用户或角色消息计为一层。</p>
                <details id="gm-result"><summary>本次回忆</summary><pre id="gm-preview">尚未生成回忆。</pre></details>
            </div>
        </div>`;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) return toastr.error('找不到酒馆扩展设置容器。', '懒人宝');
    container.append(root);
    for (const key of Object.keys(DEFAULTS)) {
        const node = $id(key);
        if (node.type === 'checkbox') node.checked = preferences()[key];
        else node.value = preferences()[key];
        node.addEventListener('change', () => {
            ctx.extensionSettings[KEY] = settings({ ...preferences(), [key]: node.type === 'checkbox' ? node.checked : node.value });
            if (node.type !== 'checkbox') node.value = preferences()[key];
            ctx.saveSettingsDebounced();
        });
    }
    $id('run').addEventListener('click', archive);
    $id('restore').addEventListener('click', restore);
    $id('refresh').addEventListener('click', refresh);
    $id('cancel').addEventListener('click', () => { cancelled = true; status('已请求取消，等待当前模型调用返回；尚未开始的写入和隐藏将停止。'); });
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        epoch++;
        $id('preview').textContent = '尚未生成回忆。';
        status(busy ? '聊天已切换，当前任务不会隐藏楼层。' : '已切换聊天。');
        if (!busy) void refresh();
    });
    void refresh();
}

jQuery(init);
