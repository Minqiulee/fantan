/**
 * 测试基座：起服务、发请求、连库、解析 CSV。
 *
 * 设计约束：
 *  - 每个测试文件独占一个数据库 schema（public 全清），只在 `node --test --test-concurrency=1`
 *    下运行，避免并发互相清库。入口见 test/run.mjs。
 *  - 服务端只通过环境变量配置，测试不 mock 任何业务逻辑：跑的是真实 server.js + 真实 Postgres。
 *  - 不引入测试框架依赖，使用 Node 内置 node:test。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'test-admin-pw';
export const PLAYER_PASSWORD = 'test-player-pw';

/**
 * 测试库连接串。**必须**由 test/run.mjs 注入（它会起临时容器并算好端口）。
 * 不设默认值：宁可报错，也不要让测试误连到开发库上执行 DROP SCHEMA。
 */
export function databaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      '未设置 TEST_DATABASE_URL。请用 `npm test` 运行（会自动起临时数据库），'
      + '或显式指定一个可清空的库：TEST_DATABASE_URL=postgres://... node --test test/'
    );
  }
  return url;
}

/** 清空 public schema：每个测试文件从零开始，避免上一轮残留影响计数断言。 */
export async function resetSchema(url = databaseUrl()) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await c.end();
  }
}

/** 直接连库执行一段查询（用于验证触发器、制造「已锁定但未归档」等状态）。 */
export async function withDb(fn, url = databaseUrl()) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 启动 server.js 子进程并等待 /api/sessions 可用。
 * 失败时把子进程日志一并抛出——启动阶段最常见的错误是库连不上。
 */
export async function startServer({ port, databaseUrl: dbUrl = databaseUrl(), env = {} } = {}) {
  const listenPort = port || await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      PORT: String(listenPort),
      ADMIN_USERNAME,
      ADMIN_PASSWORD,
      PLAYER_SESSION_PASSWORD: PLAYER_PASSWORD,
      ARCHIVE_TZ_OFFSET_MIN: '480',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  let exited = false;
  child.once('exit', () => { exited = true; });

  const base = 'http://127.0.0.1:' + listenPort;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (exited) {
      throw new Error('服务启动即退出：\n' + log);
    }
    try {
      const r = await fetch(base + '/api/sessions', { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      /* 未就绪，继续等 */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('服务 20 秒内未就绪：\n' + log);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    port: listenPort,
    get log() { return log; },
    async stop() {
      if (exited) return;
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await done;
      clearTimeout(timer);
      exited = true;
    }
  };
}

/** 极简 HTTP 客户端：JSON 接口返回 { status, body }，CSV 接口返回 { status, text, headers }。 */
export function makeClient(base) {
  const call = async (method, p, body) => {
    const opt = { method, signal: AbortSignal.timeout(15000) };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(base + p, opt);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/csv')) {
      // 用 Buffer 解码而不是 res.text()：fetch 的 text() 会按规范吃掉 BOM，
      // 而「CSV 必须带 BOM」正是要验的契约。
      const buffer = Buffer.from(await r.arrayBuffer());
      return { status: r.status, headers: r.headers, text: buffer.toString('utf8'), buffer, body: null };
    }
    return { status: r.status, headers: r.headers, text: null, body: await r.json() };
  };

  return {
    get: (p) => call('GET', p),
    post: (p, body = {}) => call('POST', p, body),
    put: (p, body = {}) => call('PUT', p, body),
    del: (p, body = {}) => call('DELETE', p, body)
  };
}

/* ---------- SSE ---------- */

/**
 * 极简 SSE 客户端：按帧解析 event / id / data，支持等待条件成立。
 *  - headers 用于模拟 EventSource 自动重连：浏览器会把上次的 id 放进 Last-Event-ID
 *  - 每条事件的 id 就是该帧的 `id:` 行；没有该行时为 null（未推进断点）
 *  - retry：服务端下发的重连间隔（毫秒），没下发时为 null
 */
export function openSse(url, { headers = {} } = {}) {
  const events = [];
  const ctrl = new AbortController();
  let retry = null;

  const ready = (async () => {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error('SSE 连接失败：' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const lines = chunk.split('\n');
            const ev = lines.find((l) => l.startsWith('event: '));
            const data = lines.find((l) => l.startsWith('data: '));
            const id = lines.find((l) => l.startsWith('id: '));
            const rt = lines.find((l) => l.startsWith('retry: '));
            if (rt) retry = Number(rt.slice(7));
            if (!ev) continue; // retry / 心跳注释不是事件
            events.push({
              event: ev.slice(7),
              id: id ? id.slice(4) : null,
              data: data ? JSON.parse(data.slice(6)) : null
            });
          }
        }
      } catch {
        /* abort 或断连，正常结束 */
      }
    })();
    return res;
  })();

  return {
    events,
    ready,
    get retry() { return retry; },
    close: () => ctrl.abort(),
    async waitFor(pred, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (events.some(pred)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }
  };
}

/* ---------- 领域动作：与前端调用的是同一批接口 ---------- */

/** 用启动时引导创建的管理员账号登录（管理员免场次口令，操作类用例都走它）。 */
export async function login(api, username = ADMIN_USERNAME, password = ADMIN_PASSWORD) {
  const r = await api.post('/api/staff-login', { username, password });
  if (!r.body || !r.body.token) throw new Error('登录失败：' + JSON.stringify(r.body));
  return r.body; // { token, sid, sessions, user }
}

export async function unlock(api, sid, password = PLAYER_PASSWORD) {
  return api.post('/api/session-unlock', { sid, password });
}

export function scan(api, sid, ut, content) {
  return api.post('/api/scan', { sid, ut, content });
}

export function predict(api, sid, ut, pid, oddEven, number) {
  return api.post('/api/predict', { sid, ut, pid, oddEven, number });
}

export function confirm(api, token, sid, number) {
  return api.post('/api/confirm', { token, sid, number });
}

export function resetRound(api, token, sid) {
  return api.post('/api/reset', { token, sid });
}

export function summary(api, token, query = '') {
  return api.get('/api/archive/summary?token=' + encodeURIComponent(token) + query);
}

export function exportCsv(api, token, { level = 'detail', query = '' } = {}) {
  return api.get(
    '/api/archive/export.csv?token=' + encodeURIComponent(token)
    + '&level=' + encodeURIComponent(level) + query
  );
}

/* ---------- CSV ---------- */

/** RFC 4180 解析：支持引号包裹、内部双写引号、CRLF/LF 混排。 */
export function parseCsv(text) {
  const s = String(text).replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r' && s[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i += 1; continue;
    }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** CSV → { header, rows, records }；records 为按列名取值的对象数组。 */
export function toTable(text) {
  const rows = parseCsv(text);
  const header = rows[0] || [];
  const body = rows.slice(1);
  return {
    header,
    rows: body,
    records: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
  };
}

/** 按会员号取一行，找不到直接报错（避免断言在 undefined 上静默通过）。 */
export function rowOf(table, memberId) {
  const found = table.records.find((r) => r['会员号'] === memberId);
  if (!found) throw new Error('CSV 中找不到会员号 ' + memberId + '；实际：' + JSON.stringify(table.records));
  return found;
}
