import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, HEADINGS, settings, plan, summarize, validateSummary, persistVerified } from '../core.js';

const chat = (n = 25) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? '小雪' : '玩家', is_user: i % 2 === 0, is_system: false, mes: `事件 ${i}` }));
const valid = HEADINGS.map(h => `## ${h}\n${h === '角色表' ? '| 姓名 | 身份 | 关系 |\n| --- | --- | --- |\n| 小雪 | 旅人 | 同伴 |' : '未交代'}`).join('\n\n');
const options = settings();

test('保留最近十层，用户与角色均按一层计数', async () => {
    const result = await plan(chat());
    assert.equal(result.end, 15);
    assert.deepEqual(result.messages.map(m => m.index), Array.from({ length: 15 }, (_, i) => i));
});
test('不满或恰好十层无需总结', async () => {
    for (const n of [0, 1, 9, 10]) assert.equal((await plan(chat(n))).messages.length, 0);
});
test('忽略手动隐藏、系统消息和空消息', async () => {
    const input = chat(13);
    input[0].is_system = true;
    input[1].mes = '  ';
    assert.deepEqual((await plan(input)).messages.map(x => x.index), [2]);
});
test('重复总结只包含新增旧楼层；改变隐藏标记不改变内容指纹', async () => {
    const input = chat();
    const first = await plan(input);
    const coverage = first.messages.map(({ index, hash }) => ({ index, hash }));
    input[0].is_system = true;
    assert.equal((await plan(input, coverage)).messages.length, 0);
    input.push(...chat(2));
    assert.deepEqual((await plan(input, coverage)).messages.map(x => x.index), [15, 16]);
});
test('已总结消息被编辑、删除、重排时停止', async () => {
    for (const action of [c => { c[0].mes = '修改'; }, c => c.shift(), c => c.reverse()]) {
        const input = chat();
        const coverage = (await plan(input)).messages;
        action(input);
        await assert.rejects(plan(input, coverage), /发生编辑/);
    }
});
test('设置约束有效且不接受未知详细程度', () => {
    assert.equal(settings({ maxTokens: -1 }).maxTokens, 256);
    assert.equal(settings({ inputTokens: Infinity }).inputTokens, 6000);
    assert.equal(settings({ detail: 'x' }).detail, 'standard');
    assert.equal(settings({ autoHide: false }).autoHide, false);
});
test('六个栏目和角色表均必须存在', () => {
    assert.equal(validateSummary(valid), valid);
    assert.throws(() => validateSummary(''), /空内容/);
    for (const h of HEADINGS) assert.throws(() => validateSummary(valid.replace(`## ${h}`, '缺失标题')), /缺少/);
    assert.throws(() => validateSummary(valid.replace('## 时间\n未交代', '## 时间\n')), /缺少/);
});

function setup(overrides = {}) {
    return { previous: '', messages: [{ index: 0, text: '发生了事件' }], options,
        contextLimit: 16000, count: async () => 200, generate: async () => valid,
        assertCurrent() {}, progress() {}, ...overrides };
}
test('旧回忆进入提示词，六项栏目与预算生效', async () => {
    let prompt;
    const result = await summarize(setup({ previous: '旧约定', generate: async (p, limit) => { prompt = p; assert.equal(limit, 1200); return valid; } }));
    assert.equal(result, valid);
    assert.match(prompt, /旧约定/);
    assert.match(prompt, /发生了事件/);
});
test('长聊天分批且每批继承上次回忆', async () => {
    let calls = 0;
    await summarize(setup({
        messages: [0, 1, 2].map(index => ({ index, text: `SOURCE${index}` })),
        count: async text => text.includes('SOURCE') ? (text.match(/SOURCE/g).length * 4000) : 200,
        generate: async prompt => { if (calls++) assert.ok(prompt.includes(valid)); return valid; },
    }));
    assert.equal(calls, 3);
});
test('单层超过预算时不调用模型，不截断原文', async () => {
    await assert.rejects(summarize(setup({ count: async () => 99999, generate: () => assert.fail('不应调用') })), /过长/);
});
test('上下文不足时停止', async () => {
    await assert.rejects(summarize(setup({ contextLimit: 2000 })), /上下文不足/);
});
test('超限输出仅重试一次，仍超限则停止', async () => {
    let calls = 0;
    await assert.rejects(summarize(setup({ count: async t => t === valid ? 2000 : 200, generate: async () => { calls++; return valid; } })), /超过 Token/);
    assert.equal(calls, 2);
});
test('聊天切换或取消在模型返回后中止', async () => {
    let changed = false;
    await assert.rejects(summarize(setup({ assertCurrent: () => { if (changed) throw new Error('切换'); }, generate: async () => { changed = true; return valid; } })), /切换/);
});
test('模型失败与空结果不会生成回忆', async () => {
    await assert.rejects(summarize(setup({ generate: async () => { throw new Error('离线'); } })), /离线/);
    await assert.rejects(summarize(setup({ generate: async () => '' })), /空内容/);
});

const book = () => ({ entries: { 0: { uid: 0, content: valid, [KEY]: { owner: 'chat' } } } });
test('保存完成后必须服务器回读一致才能返回成功', async () => {
    const sequence = [];
    const data = book();
    await persistVerified({ name: '书', data, assertCurrent: () => sequence.push('guard'), save: async () => sequence.push('save'), read: async () => { sequence.push('read'); return structuredClone(data); } });
    assert.deepEqual(sequence, ['guard', 'save', 'read', 'guard']);
});
test('即使原生保存静默失败，回读不一致也会阻止后续隐藏', async () => {
    let hidden = false;
    await assert.rejects(async () => {
        await persistVerified({ name: '书', data: book(), assertCurrent() {}, save: async () => {}, read: async () => ({ entries: {} }) });
        hidden = true;
    }, /回读不一致/);
    assert.equal(hidden, false);
});
test('保存异常或回读异常都向上传递', async () => {
    for (const where of ['save', 'read']) {
        const adapter = { name: '书', data: book(), assertCurrent() {}, save: async () => {}, read: async () => book() };
        adapter[where] = async () => { throw new Error('HTTP 500'); };
        await assert.rejects(persistVerified(adapter), /HTTP 500/);
    }
});
test('提交中聊天切换仍阻止后续隐藏', async () => {
    let switched = false;
    await assert.rejects(persistVerified({ name: '书', data: book(), assertCurrent() { if (switched) throw new Error('切换'); }, save: async () => { switched = true; }, read: async () => book() }), /切换/);
});
