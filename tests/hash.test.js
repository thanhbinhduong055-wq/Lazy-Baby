import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fingerprint } from '../core.js';
import { sha256 } from '../sha256.js';

test('HTTP 环境没有 crypto.subtle 时仍生成与旧版一致的 SHA-256 指纹', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
        for (const mes of ['', 'abc', '中文剧情 🐈\n第二行', '长消息'.repeat(500)]) {
            const message = { name: '角色', is_user: false, mes };
            const expected = createHash('sha256').update(JSON.stringify([message.name, message.is_user, message.mes])).digest('hex');
            assert.equal(await fingerprint(message), expected);
        }
    } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('备用 SHA-256 与 Node 的标准实现一致，覆盖块边界', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1024, 10000]) {
        const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
        assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'));
    }
});
test('crypto 完全不存在或 digest 拒绝时仍可生成兼容指纹', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const message = { name: '玩家', mes: '测试', is_user: true };
    const expected = await fingerprint(message);
    try {
        for (const provider of [undefined, { subtle: { digest: async () => { throw new Error('Unavailable'); } } }]) {
            Object.defineProperty(globalThis, 'crypto', { value: provider, configurable: true });
            assert.equal(await fingerprint(message), expected);
        }
    } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});
