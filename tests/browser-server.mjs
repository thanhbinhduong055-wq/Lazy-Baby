// Local, isolated browser fixture. No real chats, credentials or model requests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const base = '/scripts/extensions/third-party/lanrenbao/';
const files = new Set(['index.js', 'core.js', 'sha256.js', 'style.css']);
const worldModule = `export const worldInfoCache = new Map();
export function createWorldInfoEntry(name, data) {
 const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1;
 return data.entries[uid] = { uid, content: '', comment: '' };
}`;
const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://localhost').pathname;
        res.setHeader('Cache-Control', 'no-store');
        if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await readFile(new URL('browser.html', import.meta.url))); }
        else if (path === '/scripts/world-info.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(worldModule); }
        else if (path.startsWith(base) && files.has(path.slice(base.length))) {
            const name = path.slice(base.length);
            res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
            res.end(await readFile(new URL('../' + name, import.meta.url)));
        } else { res.statusCode = 404; res.end(); }
    } catch { res.statusCode = 500; res.end(); }
});
server.listen(8791, '127.0.0.1', () => console.log('Browser fixture: http://127.0.0.1:8791'));
