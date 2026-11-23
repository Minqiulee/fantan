'use strict';
/**
 * seats.js — 席位（seat）配置的唯一真源
 * ------------------------------------------------------------
 * 一个场次的「参与人数」就是席位总数：创建场次时物化 1…N 条 session_seat，
 * 之后只能在这个区间内扩缩容。默认值与上下界此前散落在四处，各自写死 12 / 1 / 64：
 *
 *   1. server.js  新建场次 / 场次自举的默认值、请求参数校验的上下界
 *   2. db.js      建表 DDL 的 DEFAULT、读快照与列表时的兜底、写快照、建行时的 clamp
 *   3. public/admin/app.js  新建场次弹窗的预填值与前端校验（浏览器拿不到这个模块，
 *      改为由 server 生成 /shared/seat-config.js 下发，见 serveSeatConfig）
 *   4. 文档与测试   README 的「默认 12 / 可配 1–64」
 *
 * 口径变了却只改了其中一处，就会出现「界面允许 20 人、服务端拒收」或
 * 「库里 DEFAULT 12、代码默认 10」这类漂移。所以这里只定义一次，其余全部引用。
 *
 * 注意：MIN_SEAT_COUNT 不是 0 —— 席位号从 1 开始，0 不合法，也不代表「未配置」。
 */

/** 新建场次的默认容纳人数（与运营规模 6–12 人一致）。 */
const DEFAULT_SEAT_COUNT = 6;

/** 单场最少席位数。 */
const MIN_SEAT_COUNT = 1;

/** 单场席位上限（物理座位规模远小于此，这里只是防御性上界）。 */
const MAX_SEAT_COUNT = 64;

/** 是否是合法席位数：1…64 的整数。 */
function isSeatCount(v) {
  return Number.isInteger(v) && v >= MIN_SEAT_COUNT && v <= MAX_SEAT_COUNT;
}

/**
 * 严格解析：只接受 1…64 的整数（字符串数字也接受），其余一律 null。
 * 用于所有外部入口（HTTP 请求体）——非法输入要明确报错，不能静默回退成默认值。
 */
function parseSeatCount(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return isSeatCount(n) ? n : null;
}

/**
 * 宽松收敛：把任意值夹到 1…64，非法 / 缺失时回落到默认值。
 * 只用于「程序内部已有值」的场景（读库兜底、持久化前兜底），不用于校验用户输入。
 */
function clampSeatCount(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return DEFAULT_SEAT_COUNT;
  if (typeof v === 'string' && v.trim() === '') return DEFAULT_SEAT_COUNT;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_SEAT_COUNT;
  return Math.min(Math.max(n, MIN_SEAT_COUNT), MAX_SEAT_COUNT);
}

module.exports = {
  DEFAULT_SEAT_COUNT,
  MIN_SEAT_COUNT,
  MAX_SEAT_COUNT,
  isSeatCount,
  parseSeatCount,
  clampSeatCount
};
