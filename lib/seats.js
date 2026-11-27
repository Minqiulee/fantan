'use strict';
/**
 * seats.js — 席位（seat）配置的唯一真源
 * ------------------------------------------------------------
 * 一个场次的「参与人数」就是席位总数：创建场次时按下面的席位号清单物化 N 条 session_seat，
 * 之后只能在这份清单的前 N 项内扩缩容。默认值与上下界此前散落在四处，各自写死 12 / 1 / 64：
 *
 *   1. server.js  新建场次 / 场次自举的默认值、请求参数校验的上下界
 *   2. db.js      建表 DDL 的 DEFAULT、读快照与列表时的兜底、写快照、建行时的 clamp
 *   3. public/admin/app.js  新建场次弹窗的预填值与前端校验（浏览器拿不到这个模块，
 *      改为由 server 生成 /shared/seat-config.js 下发，见 serveSeatConfig）
 *   4. 文档与测试   README 的「默认 6 / 可配 1–64」、test/seat.test.mjs 的默认值断言
 *
 * 注意：MIN_SEAT_COUNT 不是 0 —— 席位号从 1 开始，0 不合法，也不代表「未配置」。
 */

/**
 * 席位号清单：门店现场实际可用的座位编号就是这些（4、7 号位不存在）。
 * 席位数 N 对应的席位号 = 本清单前 N 项；落库的 seat_no 直接取这里的值，
 * 不再是「1…N 连续排」。扩容超出清单长度时按未占用的正整数顺延补号。
 */
const SEAT_NOS = [1, 2, 3, 5, 6, 8];

/** 新建场次的默认容纳人数（= 默认席位号清单的长度）。 */
const DEFAULT_SEAT_COUNT = SEAT_NOS.length;

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

/**
 * 席位数 → 席位号列表（升序）：取清单前 N 项；超出清单长度时按未占用的正整数顺延补号。
 * 这是「第几个座位」到「座位号是几」的唯一换算规则，物化、读库兜底、扩缩容都走它。
 */
function seatNosFor(v) {
  const n = clampSeatCount(v);
  const out = SEAT_NOS.slice(0, n);
  if (out.length < n) {
    const used = new Set(SEAT_NOS);
    let cand = SEAT_NOS[SEAT_NOS.length - 1] + 1;
    while (out.length < n) {
      if (!used.has(cand)) {
        out.push(cand);
        used.add(cand);
      }
      cand += 1;
    }
  }
  return out;
}

module.exports = {
  SEAT_NOS,
  DEFAULT_SEAT_COUNT,
  MIN_SEAT_COUNT,
  MAX_SEAT_COUNT,
  isSeatCount,
  parseSeatCount,
  clampSeatCount,
  seatNosFor
};
