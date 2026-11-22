/**
 * 测试入口：起临时 Postgres（或复用 TEST_DATABASE_URL），再跑全部测试文件。
 *
 * 用法：
 *   npm test                              # 自动用 Docker 起 postgres:16-alpine（端口 55432）
 *   TEST_DATABASE_URL=postgres://... npm test   # 用已有库，不碰 Docker
 *
 * 注意：
 *  - 测试会 `DROP SCHEMA public CASCADE`，**不要指向有数据的库**；
 *  - 用 `--test-concurrency=1` 串行执行：两个测试文件共用同一个 public schema。
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = 'oddeven-test-pg';
const FILES = [
  'test/archive.test.mjs',
  'test/archive-failure.test.mjs',
  'test/multi-instance.test.mjs',
  'test/pick.test.mjs',
  'test/prize.test.mjs',
  'test/bonus.test.mjs',
  'test/sse-reconnect.test.mjs',
  'test/identity.test.mjs'
];

let url = process.env.TEST_DATABASE_URL || '';
let containerStarted = false;

/** 取一个空闲端口给容器用：不占项目的开发库端口（常见是 55432），避免和别人抢。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function dockerAvailable() {
  const r = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  return r.status === 0;
}

async function waitForDb(connStr, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    const c = new Client({ connectionString: connStr });
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (e) {
      lastErr = e;
      try { await c.end(); } catch { /* 已断开 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('数据库 30 秒内不可用：' + (lastErr && lastErr.message));
}

function startContainer(hostPort) {
  run('docker', ['rm', '-f', CONTAINER]); // 旧容器可能配置不同，直接重建
  const r = run('docker', [
    'run', '-d', '--rm', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=oddeven_test',
    '-p', `${hostPort}:5432`,
    'postgres:16-alpine'
  ]);
  if (r.status !== 0) {
    throw new Error('启动测试数据库容器失败：\n' + (r.stderr || r.stdout));
  }
  containerStarted = true;
}

function stopContainer() {
  if (!containerStarted) return;
  run('docker', ['rm', '-f', CONTAINER]);
  containerStarted = false;
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    if (!dockerAvailable()) {
      console.error('未检测到可用的 Docker。请二选一：');
      console.error('  1. 启动 Docker Desktop 后重跑；');
      console.error('  2. 自备 Postgres 并设置 TEST_DATABASE_URL=postgres://user:pass@host:port/db');
      process.exit(1);
    }
    console.log('[test] 启动临时 Postgres 容器 ' + CONTAINER);
    const hostPort = await freePort();
    url = `postgres://postgres:postgres@127.0.0.1:${hostPort}/oddeven_test`;
    startContainer(hostPort);
  } else {
    console.log('[test] 使用 TEST_DATABASE_URL 指定的数据库');
  }

  try {
    await waitForDb(url);
  } catch (e) {
    stopContainer();
    throw e;
  }

  const child = spawn(
    process.execPath,
    ['--test', '--test-concurrency=1', ...FILES],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } }
  );

  const code = await new Promise((resolve) => child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0))));
  return code;
}

const bail = () => {
  stopContainer();
  process.exit(130);
};
process.on('SIGINT', bail);
process.on('SIGTERM', bail);

main()
  .then((code) => {
    stopContainer();
    process.exit(code);
  })
  .catch((e) => {
    stopContainer();
    console.error(e.message || e);
    process.exit(1);
  });
