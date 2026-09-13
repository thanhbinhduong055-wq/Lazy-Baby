import { createWorldInfoEntry, worldInfoCache } from '../../../world-info.js';
import { KEY, DEFAULTS, settings, plan, summarize, persistVerified, composeMemory, previousMemory, scopeMemories } from './core.js';

const context = () => SillyTavern.getContext();
let busy = false, cancelled = false, epoch = 0, refreshId = 0, tokenId = 0;
let draft = null, isolationReady = false, root;
const $id = id => root.querySelector(`#gm-${id}`);
const identity = ctx => JSON.stringify([ctx.groupId ?? null, ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId ?? null, ctx.getCurrentChatId()]);
const snapshot = ctx => JSON.stringify(ctx.chat.map(m => [m.name, m.is_user, m.is_system, m.mes]));
const preferences = () => settings(context().extensionSettings[KEY]);
const boundBook = (ctx, target) => (target === 'character' ? ctx.characters?.[ctx.characterId]?.data?.extensions?.world : ctx.chatMetadata.world_info) || '';
const ownedEntries = (data, owner) => JSON.stringify(Object.values(data.entries).filter(e => e[KEY]?.owner === owner));
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
    root.querySelectorAll('input, select, button, textarea').forEach(node => { node.disabled = value; });
    $id('cancel').disabled = !value;
    $id('cancel').hidden = !value;
    for (const id of ['save', 'regenerate']) $id(id).disabled = value || !draft;
}
function clearDraft(message) {
    draft = null;
    tokenId++;
    $id('preview').value = '';
    $id('tokens').textContent = '尚未生成草稿';
    toggleBusy(busy);
    if (message) status(message);
}
async function updateTokens() {
    const ticket = ++tokenId, owner = identity(context());
    try {
        const count = await context().getTokenCountAsync(composeMemory($id('preview').value, $id('memoryPrompt').value));
        if (ticket === tokenId && owner === identity(context())) $id('tokens').textContent = `预计写入 ${count} / ${preferences().maxTokens} tokens（包含附带提示词）`;
    } catch { if (ticket === tokenId) $id('tokens').textContent = '暂时无法计数；写入前会重新检查。'; }
}
async function refresh() {
    const ticket = ++refreshId, ctx = context(), owner = identity(ctx), target = preferences().target;
    const name = boundBook(ctx, target);
    $id('book').textContent = name || (target === 'character'
        ? '当前角色未绑定主世界书。请先在角色面板绑定，或改用聊天世界书。'
        : '未绑定聊天世界书；确认写入时自动创建并绑定。');
    const selected = $id('entry').value;
    $id('entry').replaceChildren(new Option('自动选择本聊天回忆 / 不存在则创建', 'auto'), new Option('新建记忆条目（重建前先恢复旧楼层）', 'new'));
    if (selected === 'new') $id('entry').value = 'new';
    if (!name || !ctx.getCurrentChatId()) return;
    try {
        const data = await readBook(name);
        if (ticket !== refreshId || identity(context()) !== owner || preferences().target !== target || boundBook(context(), target) !== name) return;
        for (const entry of Object.values(data.entries)) {
            if (entry[KEY]?.owner && entry[KEY].owner !== owner) continue;
            $id('entry').add(new Option(`${entry.comment || '未命名条目'} · #${entry.uid}`, String(entry.uid)));
            if (String(entry.uid) === selected) $id('entry').value = selected;
        }
    } catch (error) { if (ticket === refreshId) status(error.message); }
}
function selectEntry(data, selection, owner) {
    if (selection === 'new') return null;
    if (selection === 'auto') return Object.values(data.entries).filter(e => e[KEY]?.owner === owner && !e.disable)
        .sort((a, b) => (b[KEY].updated || 0) - (a[KEY].updated || 0))[0] || null;
    const entry = data.entries[selection];
    if (!entry) throw new Error('所选条目已不存在，请刷新条目。');
    if (entry[KEY]?.owner && entry[KEY].owner !== owner) throw new Error('该回忆属于其他聊天，请选择本聊天的条目。');
    return entry;
}
function assertDraft(value) {
    if (cancelled) throw new Error('已取消，原草稿保留。');
    const ctx = context();
    if (epoch !== value.epoch || identity(ctx) !== value.owner || ctx.chat !== value.ctx.chat || snapshot(ctx) !== value.snapshot) {
        throw new Error('聊天已切换或内容发生变化，请重新生成草稿。本次不会隐藏楼层。');
    }
    if (preferences().target !== value.target || boundBook(ctx, value.target) !== value.bookName) throw new Error('世界书绑定或写入位置已变化，请重新生成草稿。');
}
function setHidden(ctx, indices, hidden) {
    // Same flag/DOM attribute as SillyTavern hideChatMessageRange; never deletes text.
    for (const index of indices) {
        const message = ctx.chat[index];
        message.extra ||= {};
        if (hidden) message.extra[KEY] = { hidden: true };
        else delete message.extra[KEY];
        message.is_system = hidden;
        document.querySelector(`.mes[mesid="${index}"]`)?.setAttribute('is_system', String(hidden));
    }
}

async function generateDraft(regenerate = false) {
    if (busy) return;
    const ctx = context();
    if (!ctx.getCurrentChatId()) return status('请先打开一个角色或群聊。');
    if (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished || document.querySelector('#send_but')?.style.display === 'none') return status('请等待当前回复生成结束。');
    if (regenerate && !draft) return status('请先生成一份草稿。');
    const options = preferences();
    if (options.target === 'character') {
        if (ctx.groupId) return status('群聊请使用“聊天世界书”；角色世界书模式用于单角色聊天。');
        if (!isolationReady) return status('当前酒馆缺少世界书扫描事件，请更新酒馆后使用角色世界书。');
        if (!boundBook(ctx, 'character')) return status('当前角色未绑定主世界书。请先在角色面板绑定，或改用聊天世界书。');
    }
    cancelled = false;
    toggleBusy(true);
    try {
        let next;
        if (regenerate) { assertDraft(draft); next = draft; }
        else {
            next = { ctx, owner: identity(ctx), snapshot: snapshot(ctx), epoch, target: options.target,
                bookName: boundBook(ctx, options.target), selection: $id('entry').value };
            const data = next.bookName ? await readBook(next.bookName) : { entries: {} };
            assertDraft(next);
            if (!isolationReady && Object.values(data.entries).some(e => e[KEY]?.owner && e[KEY].owner !== next.owner && !e.disable)) throw new Error('当前酒馆不能隔离其他聊天的记忆，请更新酒馆或使用独立聊天世界书。');
            const entry = selectEntry(data, next.selection, next.owner);
            next.entryUid = entry?.uid ?? null;
            next.oldEntry = entry ? JSON.stringify(entry) : null;
            next.owned = ownedEntries(data, next.owner);
            next.coverage = entry?.[KEY]?.coverage || [];
            next.previous = previousMemory(entry);
            next.title = entry?.comment || `回忆 · ${ctx.name2 || '当前聊天'}`;
            const known = new Set(next.coverage.map(x => x.index));
            if (ctx.chat.some((m, i) => m.extra?.[KEY]?.hidden && !known.has(i))) throw new Error('部分隐藏楼层不在所选回忆中。请先恢复插件隐藏楼层，再新建或更换条目。');
            Object.assign(next, await plan(ctx.chat, next.coverage));
            assertDraft(next);
            if (!next.messages.length) return status('没有新增旧楼层需要总结。最近十层保持原样；若要重建，请先恢复楼层并选择新建记忆条目。');
        }
        const overhead = await ctx.getTokenCountAsync(options.memoryPrompt + '\n\n');
        assertDraft(next);
        const available = options.maxTokens - overhead - 32;
        if (available < 128) throw new Error('附带提示词占用过多 Token，请缩短提示词或提高回忆上限。');
        const memory = await summarize({
            previous: next.previous, messages: next.messages, options: { ...options, maxTokens: available },
            count: text => ctx.getTokenCountAsync(text),
            generate: (prompt, responseLength) => ctx.generateRaw({ prompt, responseLength, trimNames: false }),
            assertCurrent: () => assertDraft(next), progress: status, contextLimit: ctx.maxContext,
        });
        assertDraft(next);
        // Failed/cancelled regenerations never replace a user's existing text.
        draft = next;
        $id('preview').value = memory;
        if (!regenerate) $id('title').value = next.title;
        $id('result').open = true;
        await updateTokens();
        if (identity(context()) === next.owner) status(`草稿已生成：${next.messages.length} 层 →「${next.bookName || '待创建的聊天世界书'}」。可编辑或重新生成；尚未写入、尚未隐藏。`);
    } catch (error) { console.error('[懒人宝]', error); status(error.message); }
    finally { toggleBusy(false); }
}

async function saveDraft() {
    if (busy) return;
    if (!draft) return status('请先生成草稿。');
    const current = draft, options = preferences();
    const memory = $id('preview').value.trim(), instruction = $id('memoryPrompt').value.trim(), title = $id('title').value.trim();
    if (!memory) return status('记忆正文不能为空。');
    if (!title) return status('请填写记忆条目名称。');
    cancelled = false;
    toggleBusy(true);
    let committed = false;
    try {
        assertDraft(current);
        const content = composeMemory(memory, instruction);
        const tokens = await current.ctx.getTokenCountAsync(content);
        assertDraft(current);
        if (!Number.isFinite(tokens) || tokens > options.maxTokens) throw new Error(`编辑后的记忆与提示词共 ${tokens} tokens，超过 ${options.maxTokens} 上限。请缩短内容或提高上限。`);
        if (!current.bookName) {
            status('正在创建聊天世界书…');
            const result = await current.ctx.executeSlashCommandsWithOptions('/getchatbook');
            current.bookName = result?.pipe || '';
            assertDraft(current);
            if (!current.bookName) throw new Error('无法创建并绑定聊天世界书。');
        }
        const data = await readBook(current.bookName);
        assertDraft(current);
        if (current.entryUid !== null && JSON.stringify(data.entries[current.entryUid]) !== current.oldEntry) throw new Error('所选回忆已被修改，请重新生成草稿后再写入。');
        if (ownedEntries(data, current.owner) !== current.owned) throw new Error('本聊天的回忆条目已变化，请重新生成草稿后再写入。');
        const entry = current.entryUid === null ? createWorldInfoEntry(current.bookName, data) : data.entries[current.entryUid];
        if (!entry) throw new Error('创建世界书条目失败。');
        const coverage = [...current.coverage, ...current.messages.map(({ index, hash }) => ({ index, hash }))];
        for (const other of Object.values(data.entries)) if (other.uid !== entry.uid && other[KEY]?.owner === current.owner) other.disable = true;
        Object.assign(entry, {
            comment: title, content, constant: true, disable: false, selective: false,
            vectorized: false, probability: 100, useProbability: true,
            position: 0, order: 999, ignoreBudget: true,
            excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 0,
            group: '', triggers: [], sticky: 0, cooldown: 0, delay: 0,
            characterFilter: { names: [], tags: [], isExclude: false },
            characterFilterNames: [], characterFilterTags: [], characterFilterExclude: false,
            [KEY]: { owner: current.owner, updated: Date.now(), coverage, instruction },
        });
        status('正在写入并校验世界书…');
        try {
            await persistVerified({ name: current.bookName, data,
                assertCurrent: () => assertDraft(current),
                save: (name, value) => current.ctx.saveWorldInfo(name, value, true), read: readBook });
        } finally { worldInfoCache.delete(current.bookName); }
        committed = true;
        assertDraft(current);
        const hidden = options.autoHide ? coverage.map(x => x.index).filter(i => i < current.end && !current.ctx.chat[i].is_system) : [];
        setHidden(current.ctx, hidden, true);
        draft = null;
        await current.ctx.saveChat();
        if (identity(context()) === current.owner) status(`已写入「${current.bookName}」→「${title}」，${tokens} tokens。隐藏 ${hidden.length} 层，保留最近十层。`);
        toastr.success('已保存你确认的记忆与提示词', '懒人宝');
    } catch (error) {
        console.error('[懒人宝]', error);
        status(`${error.message}${committed ? ' 回忆已写入世界书。' : ' 未继续隐藏楼层；若写入已发出，请检查世界书。'}`);
    } finally { toggleBusy(false); await refresh(); }
}

async function restore() {
    if (busy) return;
    const ctx = context(), indices = ctx.chat.flatMap((m, i) => m.extra?.[KEY]?.hidden ? [i] : []);
    if (!indices.length) return status('没有由本插件隐藏的楼层。');
    clearDraft();
    toggleBusy(true);
    try {
        setHidden(ctx, indices, false);
        await ctx.saveChat();
        status(`已恢复 ${indices.length} 层。世界书回忆仍保留；若需重建，请选择“新建记忆条目”。`);
    } catch (error) { status(error.message); }
    finally { toggleBusy(false); }
}

function init() {
    const ctx = context();
    const required = ['generateRaw', 'getTokenCountAsync', 'saveWorldInfo', 'getCurrentChatId', 'saveChat', 'executeSlashCommandsWithOptions'];
    if (required.some(key => typeof ctx[key] !== 'function')) return toastr.error('当前酒馆缺少必需扩展接口，请更新 SillyTavern。', '懒人宝');
    if (document.getElementById('gufa-memory')) return;
    ctx.extensionSettings[KEY] = settings(ctx.extensionSettings[KEY] || DEFAULTS);
    root = document.createElement('div');
    root.id = 'gufa-memory';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>懒人宝 · 剧情记忆</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="gm-intro"><strong>旧事入册，新章续写</strong><small>先预览，改满意，再写入。最近十层原文完整保留。</small></div>
                <label>写入位置<select id="gm-target" class="text_pole"><option value="character">角色世界书 · 当前角色绑定的主世界书</option><option value="chat">聊天世界书 · 当前聊天独立记忆</option></select><small id="gm-book"></small></label>
                <label>回忆条目<select id="gm-entry" class="text_pole"></select><small>可在目标书中新建条目。选择现有条目会合并原内容；确认写入后改为常驻激活。</small></label>
                <button type="button" id="gm-refresh" class="menu_button">刷新条目</button>
                <label>信息详细程度<select id="gm-detail" class="text_pole"><option value="brief">精简 · 事件与状态</option><option value="standard">标准 · 因果与关系</option><option value="rich">详细 · 动机与伏笔</option></select></label>
                <div class="gm-grid">
                    <label>回忆 Token 上限<input id="gm-maxTokens" class="text_pole" type="number" min="256" max="8000" step="64"></label>
                    <label>单次输入 Token 预算<input id="gm-inputTokens" class="text_pole" type="number" min="1024" max="64000" step="512"></label>
                </div>
                <label>总结提示词<textarea id="gm-generationPrompt" class="text_pole" rows="3" maxlength="2000"></textarea><small>可补充关注的人物、关系或伏笔。重新生成会使用最新提示词和详细程度。</small></label>
                <label class="gm-check"><input id="gm-autoHide" type="checkbox">确认写入成功后，自动隐藏已总结楼层</label>
                <div class="gm-actions">
                    <button type="button" id="gm-run" class="menu_button gm-primary">生成记忆草稿</button>
                    <button type="button" id="gm-restore" class="menu_button">恢复插件隐藏楼层</button>
                    <button type="button" id="gm-cancel" class="menu_button" hidden>取消后续处理</button>
                </div>
                <p id="gm-status" role="status" aria-live="polite">请连接模型并打开聊天。每条用户或角色消息计为一层。</p>
                <details id="gm-result" open><summary>预览与编辑记忆</summary>
                    <label>条目名称<input id="gm-title" class="text_pole" maxlength="200" placeholder="生成后自动填写，可修改"></label>
                    <label>随记忆写入的简短提示词<textarea id="gm-memoryPrompt" class="text_pole" rows="3" maxlength="1000"></textarea><small>保存到世界书条目正文开头；不需要时可清空。</small></label>
                    <label>记忆正文<textarea id="gm-preview" class="text_pole gm-editor" rows="16" placeholder="生成的记忆会显示在这里。你可以直接编辑，再确认写入。"></textarea></label>
                    <small id="gm-tokens" role="status" aria-live="polite">尚未生成草稿</small>
                    <div class="gm-actions">
                        <button type="button" id="gm-regenerate" class="menu_button" disabled>重新生成</button>
                        <button type="button" id="gm-save" class="menu_button gm-primary" disabled>确认写入世界书</button>
                    </div>
                    <small>每次生成或重新生成最多调用模型一次，不自动分批或重试。重新生成成功后替换正文；失败保留原草稿。确认写入不调用模型。</small>
                </details>
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
            if (key === 'target') { clearDraft('写入位置已改变，请重新生成草稿。'); void refresh(); }
            if (key === 'maxTokens' || key === 'memoryPrompt') void updateTokens();
        });
    }
    $id('preview').addEventListener('input', () => { void updateTokens(); });
    $id('memoryPrompt').addEventListener('input', () => { void updateTokens(); });
    $id('entry').addEventListener('change', () => clearDraft('条目选择已改变，请重新生成草稿。'));
    $id('run').addEventListener('click', () => generateDraft());
    $id('regenerate').addEventListener('click', () => generateDraft(true));
    $id('save').addEventListener('click', saveDraft);
    $id('restore').addEventListener('click', restore);
    $id('refresh').addEventListener('click', refresh);
    $id('cancel').addEventListener('click', () => { cancelled = true; status('已请求取消，等待当前请求返回；已发出的写入无法撤回。'); });
    if (ctx.eventTypes.WORLDINFO_ENTRIES_LOADED) {
        ctx.eventSource.on(ctx.eventTypes.WORLDINFO_ENTRIES_LOADED, lore => scopeMemories(lore, identity(context())));
        isolationReady = true;
    }
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        epoch++;
        clearDraft(busy ? '聊天已切换，当前任务不会隐藏楼层。' : '已切换聊天，请重新生成草稿。');
        if (!busy) void refresh();
    });
    toggleBusy(false);
    void refresh();
}
jQuery(init);
