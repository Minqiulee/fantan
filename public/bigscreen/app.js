/* bigscreen 页面逻辑 —— 自原 bigscreen.html 内联 <script> 原样抽出 */
(function () {
  'use strict';
  /* 大屏数据流（公开访问，无登录门）：
   *   开场即连 → /api/sessions 取进行中场次 → SSE /api/stream?view=bigscreen
   * 带 ?token=（从员工端跳转）时顺手用上，可回看已关闭场次；不带也照常显示。
   * 服务端每次状态变更都用同一套 commitSession 广播全量快照（带场次版本号），
   * 这里按 version 丢弃过期帧、按 pid 做增量 diff，所以不会出现重复卡片或陈旧选项。 */
  var TOKEN_KEY = 'oe_bigscreen_token';
  var SID_KEY = 'oe_bigscreen_sid';

  var token = '';
  var sid = '';
  var sessions = [];
  var es = null;
  var streamClosed = false;
  var errCount = 0;

  var lastVersion = -1;   // 已应用的最新场次版本号（小于它的帧直接丢弃）
  var curRound = null;    // 当前轮次（变化即视为新一轮，整屏清空重来）
  var hasBaseline = false;// 是否已经渲染过首帧（首帧不产生「加入」动态）

  var cards = new Map();  // pid -> 该玩家所在的盘面 { el, refs, sig, ... }
  var slots = [];         // 铺开的席位（按席号升序）{ el, tag, card, pid, ang, no }
  var seatKey = '';       // 当前铺开的号段（"1,2,3,5,6,8"），变了才重建
  var events = [];        // 最近动态（只保留 8 条，够看就行）

  var t = window.I18N.t;
  var $ = function (id) { return document.getElementById(id); };
  var seatsEl = $('seats');

  /* ---------- 语言 ---------- */
  window.I18N.init({ storageKey: 'oe_i18n_locale' });

  function applyStaticI18n() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
    document.title = t('brand') + ' · ' + t('bs_tag');
  }
  // 切换语言后重绘所有动态文本（卡片状态/动态标签都由 t() 生成）
  document.documentElement.addEventListener('locale-change', function () {
    applyStaticI18n();
    refreshSeatTags();
    if (lastPayload) applyState(lastPayload, true);
    renderTicker();
  });

  var lastPayload = null;

  /* ---------- 小工具 ---------- */
  function hhmmss(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ } }
  function load(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }

  setInterval(function () { $('clock').textContent = hhmmss(Date.now()); }, 1000);
  $('clock').textContent = hhmmss(Date.now());

  /* ---------- 准入：公开访问，无登录门 ----------
   * 大屏默认公开（服务端 BIGSCREEN_PUBLIC 控制），打开即连，不弹账号/口令。
   * 从员工端跳转过来会带 ?token=：有就用（能回看已关闭场次），没有也照样能看。 */
  function setToken(tk) { token = tk || ''; if (token) save(TOKEN_KEY, token); else drop(TOKEN_KEY); }

  /* ---------- 场次 ---------- */
  /** 公开场次列表（/api/sessions 不带 token）只含进行中的场次且不带 status，按 open 处理 */
  function isOpenSession(s) { return s.status ? s.status === 'open' : true; }

  function pickSession(preferred) {
    var i;
    if (preferred) {
      for (i = 0; i < sessions.length; i++) if (sessions[i].id === preferred && isOpenSession(sessions[i])) return preferred;
    }
    for (i = 0; i < sessions.length; i++) if (sessions[i].id === sid && isOpenSession(sessions[i])) return sid;
    for (i = 0; i < sessions.length; i++) if (isOpenSession(sessions[i])) return sessions[i].id;
    return '';
  }

  function renderSessions() {
    var open = sessions.filter(isOpenSession);
    var sel = $('sessSel');
    sel.classList.toggle('hidden', open.length < 2);
    sel.innerHTML = '';
    open.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name + ' · ' + t('bs_round', { n: s.round });
      if (s.id === sid) o.selected = true;
      sel.appendChild(o);
    });
  }

  $('sessSel').addEventListener('change', function () {
    var next = this.value;
    if (next && next !== sid) switchTo(next);
  });

  /** 拉场次列表：公开大屏也走这里（无 token 只返回进行中的场次） */
  function refreshSessions() {
    return fetch('/api/sessions' + (token ? '?token=' + encodeURIComponent(token) : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.sessions) { sessions = d.sessions; renderSessions(); return sessions; }
        return [];
      })
      .catch(function () { return []; });
  }

  /** 切场次：重置本地 diff 状态并重连，避免把上一场的卡片带进来 */
  function switchTo(next) {
    if (!next) { showNoSession(); return; }
    sid = next;
    save(SID_KEY, sid);
    $('empty').classList.remove('on');
    resetBoard();
    renderSessions();
    startStream();
    poll();
  }

  function showNoSession() {
    closeStream();
    $('sessName').textContent = '—';
    $('sessMeta').textContent = '';
    resetBoard();
    ensureSeats([]);         // 没有场次就没有席位：整块桌面收起
    $('empty').classList.add('on');
    $('empty').textContent = t('bs_noSession');
  }

  function resetBoard() {
    cards.clear();
    slots.forEach(function (s) { s.pid = null; paintEmpty(s.card); });
    events = [];
    lastVersion = -1;
    curRound = null;
    hasBaseline = false;
    lastPayload = null;
    $('drawBox').classList.add('idle');
    $('drawNum').textContent = t('bs_drawing');
    renderTicker();
    renderStats([]);
  }

  /* ---------- 渲染：顶栏 / 概览 / 开奖 ---------- */
  function renderHead(d) {
    var s = d.session || {};
    $('sessName').textContent = s.name || '—';
    var meta = $('sessMeta');
    meta.innerHTML = '';
    var pill = document.createElement('span');
    pill.className = 'state-pill' + (d.locked ? ' locked' : '');
    var dot = document.createElement('span');
    dot.className = 'dot';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(t(d.locked ? 'bs_locked' : 'bs_live')));
    meta.appendChild(pill);
    var sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '·';
    meta.appendChild(sep);
    var rnd = document.createElement('span');
    rnd.textContent = t('bs_round', { n: d.round });
    meta.appendChild(rnd);

    var box = $('drawBox');
    var num = $('drawNum');
    if (d.locked && d.number != null) {
      box.classList.remove('idle');
      num.textContent = d.number;
      num.removeAttribute('data-i18n');
    } else {
      box.classList.add('idle');
      num.textContent = t('bs_drawing');
    }
  }

  /** 统计以服务端 counts 为准（与员工端同一份快照、同一口径：只算在场玩家）；
   *  counts 缺失时退回当前列表。草稿数由 draft 补丁即时更新，所以从 list 现算。 */
  function renderStats(list, counts) {
    var c = counts || {};
    var total = c.total != null ? c.total : list.length;
    var picked = c.submitted != null ? c.submitted : 0;
    var draft = 0;
    if (c.submitted == null) {
      list.forEach(function (p) { if (p.submitted) picked += 1; });
    }
    list.forEach(function (p) {
      if (!p.submitted && p.status === 'draft') draft += 1;
    });
    $('nTotal').textContent = total;
    $('nPicked').textContent = picked;
    if ($('nDraft')) $('nDraft').textContent = draft;
    $('nUnpicked').textContent = Math.max(0, total - picked - draft);
    $('empty').classList.toggle('on', total === 0);
    if (total === 0) $('empty').textContent = t('bs_waiting');
  }

  /* 桌面尺寸变了（投屏缩放 / 换分辨率）就重算席位——位置是算出来的，不能交给 CSS */
  if (window.ResizeObserver) {
    new ResizeObserver(function () { layoutSeats(); }).observe(seatsEl);
  } else {
    window.addEventListener('resize', layoutSeats);
  }

  /* ---------- 渲染：玩家卡片（按 pid 增量 diff） ---------- */
  function stateOf(p) {
    if (p.submitted) return 'picked';
    return p.status === 'draft' ? 'draft' : 'unpicked';
  }

  function sigOf(p) {
    return [p.status || '', p.oe || '', p.num == null ? '' : p.num].join('|');
  }

  /* ---------- 席位：沿桌面弧线铺开 ----------
   * 对着实桌的做法：投注盘贴着桌沿摆一圈，盘面朝外、牌位朝桌心，开奖结果钉在弧心。
   * 席位是固定槽位（1…seatCount）：有人就把人画到盘面上，没人就留一张空盘。
   *
   * 几何上的三处取舍：
   *   1. 盘面按所在位置的**椭圆外法线**转角：盘的下沿与桌面弧线平行，一圈盘才像
   *      搁在同一张弧形桌沿上，而不是各转各的。端部封顶 66°，不让最外侧的盘横躺。
   *   2. 盘宽和盘位由同一条弧长算出：相邻盘之间的弧长必须大于盘宽，所以盘与盘
   *      不可能叠；席位多时盘自动收小，席位少时盘封顶、按等距铺开。
   *   3. 桌沿、绒面、金线全部由这条席位环的平行曲线推出（pushTableVars），
   *      盘外沿到桌沿的留白处处一样宽——「贴合」是算出来的，不是靠肉眼对的。
   */
  var GEO = {
    span: 74,       // 席位弧的半角（度）：端部的盘侧倾 50–60°，弧够长又不横躺
    rotMax: 66,     // 盘面转角封顶：再转下去字就横躺了
    gap: .085,      // 相邻盘之间的缝（相对盘宽）
    maxW: .135,     // 盘宽上限（stage 宽的比例）：席位少时别把盘撑得没有缝
    maxH: .32,      // 盘宽上限（stage 高的比例）
    rail: .225      // 盘外沿到桌沿的留白（占桌沿椭圆纵向半径的比例；直边贴弧，四角还要让出拱高）
  };

  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 半椭圆（正下方 0 → 正上方 π）的弧长累计表：把「等弧长」反查回角度。
   *  inset > 0 时统计的是「内缩 inset 后的平行曲线」的弧长——盘面按法线转角后，
   *  内沿走的是比中线更短的弧，只有按内沿等距排，相邻两盘的**内角**才不会顶在一起
   *  （外沿那一侧会自然张开一点，正是一圈盘搁在弧形桌沿上的样子）。 */
  function arcTable(rx, ry, inset) {
    var STEP = 360, cum = new Float64Array(STEP + 1), i;
    var px = 0, py = 0;
    for (i = 0; i <= STEP; i++) {
      var a = (i / STEP) * Math.PI;
      var nx = Math.sin(a) / rx, ny = Math.cos(a) / ry;
      var nl = Math.hypot(nx, ny);
      var x = rx * Math.sin(a) - inset * nx / nl;
      var y = ry * Math.cos(a) - inset * ny / nl;
      if (i) cum[i] = cum[i - 1] + Math.hypot(x - px, y - py);
      px = x; py = y;
    }
    return { cum: cum, step: STEP, perim: cum[STEP] * 2 };
  }

  /** 弧长（带符号，正=右半圈）反查极角 */
  function angAtArc(ring, s) {
    var sign = s < 0 ? -1 : 1, t = Math.abs(s);
    var cum = ring.cum, STEP = ring.step;
    if (t >= cum[STEP]) return sign * Math.PI;
    var lo = 1, hi = STEP;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] < t) lo = mid + 1; else hi = mid;
    }
    var seg = cum[lo] - cum[lo - 1];
    var frac = seg > 1e-6 ? (t - cum[lo - 1]) / seg : 0;
    return sign * ((lo - 1 + frac) / STEP) * Math.PI;
  }

  /** 盘面转角：椭圆在这一点上的外法线方向。
   *  盘面的「下」正对外法线，下沿就与桌面弧线平行——盘面是搁在桌沿上，不是插在桌上。
   *  按法线算而不是按极角算：席位环是扁椭圆，极角和法线差得不小，照极角转
   *  两端的盘会歪着咬进桌沿。端部封顶 66°：再转盘面就横躺，投屏远看一个字都认不出。 */
  function normalDeg(ang, rx, ry) {
    var deg = -Math.atan2(Math.sin(ang) / rx, Math.cos(ang) / ry) * 180 / Math.PI;
    return clampNum(deg, -GEO.rotMax, GEO.rotMax);
  }

  /** 桌前家具（绒面 / 桌沿 / 金线）跟着席位环走：半径由席位环向外平移得出，
   *  盘外沿离桌沿的留白才是恒定的一道缝，整圈看起来才是一张桌子。 */
  function pushTableVars(cy, rx, ry, sw, rail) {
    var stageEl = seatsEl.parentNode;
    if (!stageEl || !stageEl.style) return;
    var pad = sw / 2 + rail;
    stageEl.style.setProperty('--tbl-cy', cy.toFixed(0) + 'px');
    stageEl.style.setProperty('--tbl-w', Math.max(160, (rx + pad) * 2).toFixed(0) + 'px');
    stageEl.style.setProperty('--tbl-h', Math.max(160, (ry + pad) * 2).toFixed(0) + 'px');
    stageEl.style.setProperty('--ring-cy', cy.toFixed(0) + 'px');
    stageEl.style.setProperty('--ring-in-w', Math.max(80, (rx - sw * .56) * 2).toFixed(0) + 'px');
    stageEl.style.setProperty('--ring-in-h', Math.max(80, (ry - sw * .56) * 2).toFixed(0) + 'px');
  }

  function layoutSeats() {
    var n = slots.length;
    if (!n) return;
    var W = seatsEl.clientWidth || 1280;
    var H = seatsEl.clientHeight || 620;
    var cx = W / 2;
    var swMax = Math.min(W * GEO.maxW, H * GEO.maxH);
    // 桌心留够高度：端部盘面斜着摆，包围盒的上沿不能顶出 stage（否则被裁掉一条）
    var cy = Math.max(H * .16, swMax * .70 + 8);

    // 盘宽 ↔ 席位环互相牵制：盘越宽，环越靠内、可用弧长越短。迭代几次就收敛。
    // 盘宽只由弧长反推，不做「能撑多大就撑多大」——席位一多，盘必须自己缩小。
    var sw = swMax, rx = 0, ry = 0, ring = null, rail = 0;
    for (var pass = 0; pass < 8; pass++) {
      var rimRy = Math.max(H * .3, H * .988 - cy);       // 桌沿椭圆的纵向半径
      rail = rimRy * GEO.rail;
      rx = Math.max(W * .18, W / 2 - sw * .69 - 8);       // 端部盘面斜摆，横向占 .69 个盘宽
      ry = Math.max(H * .20, rimRy - sw / 2 - rail);      // 盘外沿压在桌沿内侧
      ring = arcTable(rx, ry, sw / 2);                    // 按盘面内沿算可用弧长
      if (n === 1) break;
      var fit = ring.perim * GEO.span / 180 / (n - 1) / (1 + GEO.gap);
      var next = Math.max(26, Math.min(swMax, fit));
      var done = Math.abs(next - sw) < .5;
      sw = next;
      if (done) break;
    }
    ring = arcTable(rx, ry, sw / 2);

    var avail = ring.perim * GEO.span / 180;
    // 盘封顶时把席位按等距铺满整段弧（缝看着才均匀）；没封顶就紧排，只留一道缝
    var pitch = n > 1 ? Math.max(sw * (1 + GEO.gap), avail / (n - 1)) : 0;

    seatsEl.style.setProperty('--sw', sw.toFixed(1) + 'px');
    seatsEl.style.setProperty('--sh', sw.toFixed(1) + 'px');
    pushTableVars(cy, rx, ry, sw, rail);

    for (var i = 0; i < n; i++) {
      var s = slots[i];
      var ang = n === 1 ? 0 : angAtArc(ring, (i - (n - 1) / 2) * pitch);
      s.ang = ang;
      s.el.style.left = (cx + rx * Math.sin(ang)).toFixed(1) + 'px';
      s.el.style.top = (cy + ry * Math.cos(ang)).toFixed(1) + 'px';
      s.el.style.setProperty('--rot', normalDeg(ang, rx, ry).toFixed(2) + 'deg');
    }
  }

  /** 铺开给定的席位号（如 1,2,3,5,6,8——现场桌位的编号本来就不连续）。
   *  号段变了才重建：只换人不换号时，盘面原地更新，不会整桌闪一下。 */
  function ensureSeats(nums) {
    var key = nums.join(',');
    if (key === seatKey) return;
    seatKey = key;
    cards.clear();
    slots.forEach(function (s) { s.el.remove(); });
    slots = nums.slice(0, 64).map(function (no) { return makeSeat(no); });
    layoutSeats();
  }

  /** 席位号从负载里取：优先用服务端 seats 的原编号（可能不连续），没有就 1…seatCount */
  function seatNumbersOf(d) {
    var out = [];
    if (d && d.seats && d.seats.length) {
      d.seats.forEach(function (s) { if (s && s.no != null) out.push(Number(s.no)); });
    } else {
      var n = Number(d && d.seatCount) || 0;
      for (var i = 1; i <= n; i++) out.push(i);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function refreshSeatTags() {
    slots.forEach(function (s) { s.tag.textContent = t('bs_seat', { n: s.no }); });
  }

  /* ---------- 盘面：一块盘 + 谁坐在上面 ----------
   * 盘体直接用 assets/pad.webp：外圈金框、两块米色牌面（单/双）、下半的深色键区都在图上。
   * 我们只在图上"贴"三个可变的层：
   *   1. 名牌（压在盘面顶部的拱形饰件上）——谁坐这儿、确认了没；
   *   2. 牌面压暗层——盖住米色牌面，未选中时整块压暗；
   *   3. 键区——1–8 八格（4 列 × 2 行），按参考盘那 8 个固定键位摆，键面写「N羊」。
   * 位置全部用百分比贴在图上，所以盘面尺寸怎么变都对得上。
   */
  function makeBoard() {
    var el = document.createElement('article');
    el.className = 'pc';

    var pad = document.createElement('div');
    pad.className = 'pc-pad';

    var top = document.createElement('div');
    top.className = 'pc-top';
    var l1 = document.createElement('div');
    l1.className = 'pc-top-l1';
    var dot = document.createElement('span');
    dot.className = 'pc-dot';
    var idEl = document.createElement('b');
    idEl.className = 'pc-id';
    var vet = document.createElement('span');
    vet.className = 'pc-vet';
    vet.textContent = t('bs_vet');
    l1.appendChild(dot);
    l1.appendChild(idEl);
    l1.appendChild(vet);
    var st = document.createElement('div');
    st.className = 'pc-st';
    top.appendChild(l1);
    top.appendChild(st);

    // 单双：与玩家端 .pair .opt 一一对应，两块牌面各占一半，只把选中的那块点亮
    var oeWrap = document.createElement('div');
    oeWrap.className = 'pc-oe';
    var oeRefs = [];
    ['单', '双'].forEach(function (v) {
      var plate = document.createElement('div');
      plate.className = 'pc-plate';
      plate.setAttribute('data-oe', v);
      var lab = document.createElement('span');
      lab.className = 'pl-lab';
      lab.textContent = t(v === '单' ? 'oeOddName' : 'oeEvenName');
      var nums = document.createElement('span');
      nums.className = 'pl-num';
      nums.textContent = t(v === '单' ? 'oeOddNums' : 'oeEvenNums');
      var veil = document.createElement('span');
      veil.className = 'pl-veil';
      plate.appendChild(lab);
      plate.appendChild(nums);
      plate.appendChild(veil);
      oeWrap.appendChild(plate);
      oeRefs.push({ root: plate, lab: lab, nums: nums });
    });

    // 数字键区：与参考盘一一对应，4 列 × 2 行、只有 1–8，键面写「N羊」
    var key = document.createElement('div');
    key.className = 'pc-key';
    var numWrap = document.createElement('div');
    numWrap.className = 'numgrid pc-numgrid';
    var cellRefs = [];
    for (var i = 1; i <= 8; i++) {
      var c = document.createElement('span');
      c.setAttribute('data-n', String(i));
      var cn = document.createElement('b');
      cn.className = 'kn';
      cn.textContent = String(i);
      var cu = document.createElement('i');
      cu.className = 'ku';
      cu.textContent = t('sheepUnit');
      // 单位写在数字元素里面（行内），两者自然同基线；外层只负责把数字那一行居中。
      // 单位后缀一律挂着（英文下为空、由 CSS 隐藏），切语言时才不用重建 DOM
      cn.appendChild(cu);
      c.appendChild(cn);
      numWrap.appendChild(c);
      cellRefs.push(c);
    }
    key.appendChild(numWrap);

    el.appendChild(pad);
    el.appendChild(top);
    el.appendChild(oeWrap);
    el.appendChild(key);

    return {
      el: el,
      refs: { pad: pad, top: top, id: idEl, vet: vet, st: st, oe: oeRefs, cells: cellRefs },
      sig: '', locked: false, submitted: false
    };
  }

  /** 空席 = 一张没人动过的盘：整块压暗，不留姓名/状态/提示 */
  function paintEmpty(card) {
    card.el.setAttribute('data-state', 'empty');
    card.refs.top.style.display = 'none';
    card.refs.id.textContent = '';
    card.refs.id.removeAttribute('title');
    card.refs.vet.style.display = 'none';
    card.refs.st.textContent = '';
    card.refs.oe.forEach(function (o) { o.root.classList.remove('sel', 'hit', 'mk'); });
    card.refs.cells.forEach(function (el) { el.classList.remove('sel', 'hit', 'mk'); });
    card.el.setAttribute('data-hit', '0');
    card.sig = '';
    card.locked = false;
    card.submitted = false;
  }

  function makeSeat(no) {
    var el = document.createElement('div');
    el.className = 'seat';
    el.setAttribute('data-seat', no);

    var tag = document.createElement('div');
    tag.className = 'seat-tag';
    tag.textContent = t('bs_seat', { n: no });

    var card = makeBoard();
    paintEmpty(card);
    // 牌位挂在盘面里，跟着盘面同一个 transform 转：位置和角度都不另算
    card.el.appendChild(tag);
    el.appendChild(card.el);
    seatsEl.appendChild(el);

    return { el: el, tag: tag, card: card, pid: null, ang: 0, no: no };
  }

  /** 把一份玩家数据画到卡片上（d = 当前状态负载，含 locked / number 用于命中标记）
   *  选择结果全部用图示表达：单双两枚 + 1–8 八格，筹码压在选中的那格/那块牌面上。
   *  三个状态类各管一件事，别混：
   *    .mk  —— 这是他押的（筹码就压在这儿；开奖前后都在，用来读「押了哪个」）
   *    .sel —— 高亮（未开奖时等于 .mk；开奖后只有命中的那个才留 .sel）
   *    .hit —— 开奖后命中，唯一带「正确」对勾的标记 */
  function paintCard(card, p, d) {
    card.el.setAttribute('data-state', stateOf(p));
    // 盘面是复用的：上一个玩家走了留下的空盘要先恢复出名牌
    card.refs.top.style.display = '';
    card.refs.id.textContent = p.maskedId || p.id;   // 只展示脱敏标签，明文会员号不下发到浏览器
    card.refs.id.title = p.maskedId || p.id;
    card.refs.vet.style.display = p.isVeteran ? '' : 'none';

    // oe/num 是「当前显示值」：已确认取提交值，未确认取草稿值（服务端算好，前端不猜）
    var oe = (p.oe === '单' || p.oe === '双') ? p.oe : null;
    var num = (p.num == null || p.num === '') ? null : Number(p.num);
    var locked = !!(d && d.locked && d.number != null);
    var judged = locked && !!p.submitted;   // 只有已确认的提交才判命中，草稿不判
    var oeWin = locked ? (d.number % 2 === 1 ? '单' : '双') : null;
    var oeHit = judged && oe !== null && oe === oeWin;
    var numHit = judged && num !== null && num === d.number;

    // 单双两块牌面：开奖前选中即高亮；开奖后只有命中的那块继续高亮并打勾，
    // 其余牌面一律退回未选中样式——筹码留着当「押过这边」的记号，但不点亮。
    card.refs.oe.forEach(function (o) {
      var mine = oe !== null && o.root.getAttribute('data-oe') === oe;
      var hit = mine && oeHit;
      o.root.classList.toggle('mk', mine);
      o.root.classList.toggle('sel', mine && (!locked || hit));
      o.root.classList.toggle('hit', hit);
      var odd = o.root.getAttribute('data-oe') === '单';
      o.lab.textContent = t(odd ? 'oeOddName' : 'oeEvenName');
      o.nums.textContent = t(odd ? 'oeOddNums' : 'oeEvenNums');
    });

    // 数字八格：同一套规则（.mk 压筹码 / .sel 高亮 / .hit 打勾）
    // 单位后缀（羊）随语言切换，切语言时整屏重绘会走到这里
    var unit = t('sheepUnit');
    card.refs.cells.forEach(function (el) {
      var n = Number(el.getAttribute('data-n'));
      var mine = num !== null && n === num;
      var hit = mine && judged && d.number === n;
      el.classList.toggle('mk', mine);
      el.classList.toggle('sel', mine && (!locked || hit));
      el.classList.toggle('hit', hit);
      var ku = el.querySelector('.ku');
      if (ku) ku.textContent = unit;
    });

    // 名牌第二行只留一句状态；命中的写成「命中」并走绿字（大屏远看最先读到的就是这句）
    var win = judged && (oeHit || numHit);
    card.el.setAttribute('data-hit', win ? '1' : '0');
    card.refs.st.textContent = t(win ? 'bs_hit'
      : p.submitted ? 'bs_statePicked'
      : p.status === 'draft' ? 'bs_stateDraft'
      : 'bs_stateUnpicked');

    card.sig = sigOf(p);
    card.locked = !!(d && d.locked);
    card.submitted = p.submitted;
    card.oddEven = p.oddEven;
    card.number = p.number;
  }

  function flash(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;   // 强制回流，让同一张卡片连续两次变化也能重新播放
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 950);
  }

  /** 玩家落到哪个席位：认席号，不认下标（席号可能不连续）；对不上（理论上不会）就补第一个空位 */
  function seatIndex(p, want) {
    var no = Number(p.seatNo);
    if (Number.isInteger(no)) {
      for (var k = 0; k < slots.length; k++) {
        if (slots[k].no === no) return want[k] ? -1 : k;
      }
    }
    for (var i = 0; i < slots.length; i++) if (!want[i]) return i;
    return -1;
  }

  function syncCards(list, d) {
    var seen = Object.create(null);
    var want = new Array(slots.length);
    var i;
    for (i = 0; i < slots.length; i++) want[i] = null;

    list.forEach(function (p) {
      seen[p.id] = 1;
      var idx = seatIndex(p, want);
      if (idx >= 0) want[idx] = p;
    });

    slots.forEach(function (slot, idx) {
      var p = want[idx];
      var card = slot.card;
      var prev = slot.pid;

      if (!p) {
        // 这个人走了：席位退回默认棋盘（不留空、不留占位字样）
        if (prev) {
          cards.delete(prev);
          slot.pid = null;
          paintEmpty(card);
          if (hasBaseline) pushEvent('leave', prev);
        }
        return;
      }

      var known = cards.get(p.id);
      if (!known || known.el !== card.el) {
        // 新面孔落座（同一席位换人时，上一位的盘面直接被覆盖）
        if (prev && prev !== p.id) cards.delete(prev);
        slot.pid = p.id;
        paintCard(card, p, d);
        cards.set(p.id, card);
        if (hasBaseline) { pushEvent('join', p.id); flash(slot.el, 'enter'); }
        return;
      }

      var next = sigOf(p);
      // 开奖/撤销开奖不改变选择签名，但要让命中标记重新画一遍，所以单列一个判断
      var lockedChanged = (d && d.locked ? 1 : 0) !== (card.locked ? 1 : 0);
      if (card.sig === next && !lockedChanged) return;
      var old = { submitted: card.submitted, oddEven: card.oddEven, number: card.number };
      paintCard(card, p, d);
      if (hasBaseline) {
        if (p.submitted && !old.submitted) pushEvent('pick', p.id);
        else if (p.submitted && old.submitted && (p.oddEven !== old.oddEven || p.number !== old.number)) pushEvent('change', p.id);
      }
      flash(slot.el, 'change');
    });

    // 不在本帧里的：本轮已重置或玩家被移除，连记录一起清掉，避免残留过期数据
    cards.forEach(function (card, pid) { if (!seen[pid]) cards.delete(pid); });

    $('empty').classList.toggle('on', list.length === 0);
    if (list.length === 0) $('empty').textContent = t('bs_waiting');
  }

  /* ---------- 最近动态 ---------- */
  function pushEvent(kind, arg) {
    events.unshift({ kind: kind, arg: arg, at: Date.now() });
    if (events.length > 8) events.pop();
    renderTicker();
  }

  function renderTicker() {
    var box = $('tkList');
    box.innerHTML = '';
    events.forEach(function (e) {
      var row = document.createElement('span');
      row.className = 'tk ' + e.kind;
      var tag = document.createElement('span');
      tag.className = 'tg';
      tag.textContent = t(e.kind === 'join' ? 'bs_evJoin'
        : e.kind === 'pick' ? 'bs_evPick'
        : e.kind === 'change' ? 'bs_evChange'
        : e.kind === 'leave' ? 'bs_evLeave'
        : 'bs_evRound');
      var name = document.createElement('b');
      name.textContent = e.kind === 'round' ? t('bs_round', { n: e.arg }) : e.arg;
      var time = document.createElement('span');
      time.className = 't';
      time.textContent = hhmmss(e.at);
      row.appendChild(tag);
      row.appendChild(name);
      row.appendChild(time);
      box.appendChild(row);
    });
  }

  /* ---------- 草稿补丁 ----------
   * 草稿只存服务端内存、不推进 version，走不了全量快照。服务端按 500ms 窗口把
   * 变化的玩家攒成一条 draft 事件，这里按 pid 就地改 lastPayload 再走同一套 diff。
   * 已确认的玩家忽略补丁：确认值一旦落库就不会再被草稿覆盖。 */
  function applyDraftPatch(items) {
    if (!lastPayload || !lastPayload.players) return;
    var byId = Object.create(null);
    lastPayload.players.forEach(function (p) { byId[p.id] = p; });
    var touched = 0;
    items.forEach(function (it) {
      var p = byId[it && it.pid];
      if (!p || p.submitted) return;
      if (it.draft) {
        p.status = 'draft';
        p.oe = it.draft.oe;
        p.num = it.draft.num;
        p.draftOddEven = it.draft.oe;
        p.draftNumber = it.draft.num;
        p.draftSeq = it.draft.seq;
      } else {
        p.status = 'none';
        p.oe = null;
        p.num = null;
        p.draftOddEven = null;
        p.draftNumber = null;
        p.draftSeq = null;
      }
      touched += 1;
    });
    if (!touched) return;
    syncCards(lastPayload.players, lastPayload);
    renderStats(lastPayload.players, lastPayload.counts);
  }

  /* ---------- 状态应用 ---------- */
  function applyState(d, force) {
    if (!d || !d.ok) return;
    // 员工 token 能读已关闭场次的历史快照，但大屏只跟进行中的场次
    if (d.session && d.session.status === 'closed') { onSessionClosed(); return; }
    lastPayload = d;

    if (d.session && d.session.id && d.session.id !== sid) {
      sid = d.session.id;
      save(SID_KEY, sid);
      renderSessions();
    }

    if (d.version != null) {
      // 过期帧（重连补发、并发请求乱序）一律丢弃，避免把旧选项盖回新选项
      if (!force && lastVersion >= 0 && d.version < lastVersion) return;
      if (d.version > lastVersion) lastVersion = d.version;
    }

    if (curRound != null && d.round !== curRound) {
      // 新一轮：整块桌面清回默认棋盘，只留一条「第 N 轮开始」
      cards.clear();
      slots.forEach(function (s) { s.pid = null; paintEmpty(s.card); });
      pushEvent('round', d.round);
    }
    curRound = d.round;

    // 席位以服务端为准（空席也要摆出来，整张桌子才是完整的）；号段可能不连续
    ensureSeats(seatNumbersOf(d));

    renderHead(d);
    renderStats(d.players || [], d.counts);
    syncCards(d.players || [], d);
    if (force) {
      // 切语言后重绘（选择没变，diff 不会触发），让「已选择/老玩家/命中」等文案跟上
      var byId = Object.create(null);
      (d.players || []).forEach(function (p) { byId[p.id] = p; });
      cards.forEach(function (c, pid) { if (byId[pid]) paintCard(c, byId[pid], d); });
    }
    hasBaseline = true;
    $('connTip').classList.remove('on');
  }

  /* ---------- 网络：SSE + 快照对齐 ---------- */
  function closeStream() {
    streamClosed = true;
    if (es) { es.close(); es = null; }
  }

  /** 大屏请求参数：token 只在不为空时带上（公开模式不需要） */
  function boardQuery(withSid) {
    var qs = 'view=bigscreen';
    if (withSid && sid) qs = 'sid=' + encodeURIComponent(sid) + '&' + qs;
    if (token) qs += '&token=' + encodeURIComponent(token);
    return qs;
  }

  function startStream() {
    closeStream();
    if (!sid) return;
    streamClosed = false;
    errCount = 0;
    es = new EventSource('/api/stream?' + boardQuery(true));

    es.onopen = function () {
      errCount = 0;
      $('connTip').classList.remove('on');
      poll();   // 重连成功：补一次全量快照，消除断线期间错过的变更
    };

    es.addEventListener('state', function (ev) {
      try { applyState(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    });

    es.addEventListener('draft', function (ev) {
      var d = {};
      try { d = JSON.parse(ev.data) || {}; } catch (e) { return; }
      if (d.sid && d.sid !== sid) return;
      applyDraftPatch(d.items || []);
    });

    es.addEventListener('session_closed', function (ev) {
      var d = {};
      try { d = JSON.parse(ev.data) || {}; } catch (e) { /* 忽略坏帧 */ }
      if (d.sid && d.sid !== sid) return;
      onSessionClosed();
    });

    es.onerror = function () {
      if (streamClosed) return;
      if (es && es.readyState === EventSource.CONNECTING) $('connTip').classList.add('on');
      // 连续失败后主动核对一次准入：密码会话过期/场次被关都会在这里暴露出来
      if (++errCount >= 3) { errCount = 0; poll(); }
    };
  }

  /** 拉一次全量快照（首连、重连、回到前台都走这里，保证与服务端版本对齐） */
  function poll() {
    if (!sid) return;
    fetch('/api/state?' + boardQuery(true), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { applyState(d); return; }
        var code = d && d.code;
        if (code === 'session_closed' || code === 'session_not_found') { onSessionClosed(); return; }
        if (code === 'bigscreen_unauthorized' || code === 'session_need_unlock' || code === 'session_locked') {
          // 公开模式被关掉 / 场次口径不一致：不弹任何输入框，清掉令牌后重新找当前进行中的场次
          setToken('');
          refreshSessions().then(function () {
            var next = pickSession('');
            if (next && next !== sid) { switchTo(next); return; }
            if (next) { startStream(); return; }
            $('connTip').classList.add('on');
          });
          return;
        }
        $('connTip').classList.add('on');
      })
      .catch(function () { $('connTip').classList.add('on'); });
  }

  function onSessionClosed() {
    closeStream();
    resetBoard();
    ensureSeats([]);
    $('sessName').textContent = '—';
    $('sessMeta').textContent = '';
    $('empty').classList.add('on');
    $('empty').textContent = t('bs_noSession');
    refreshSessions().then(function () {
      var next = pickSession('');
      if (next && next !== sid) { switchTo(next); return; }
      if (next) { startStream(); return; }
      // 没有可看的场次：挂机重试，等工作人员开出新场次后自动接上
      setTimeout(onSessionClosed, 5000);
    });
  }

  /* ---------- 启动（公开：打开即连，不弹登录） ---------- */
  function bootstrap() {
    var q = {};
    try {
      var sp = new URLSearchParams(location.search);
      q.token = sp.get('token') || '';
      q.sid = sp.get('sid') || '';
    } catch (e) { q.token = ''; q.sid = ''; }

    // 从工作人员端跳转过来会带 token：只存本地并立刻从地址栏抹掉（避免留在历史记录里）
    if (q.token) {
      setToken(q.token);
      try { history.replaceState(null, '', location.pathname + (q.sid ? '?sid=' + encodeURIComponent(q.sid) : '')); } catch (e) { /* 忽略 */ }
    }
    if (q.sid) { sid = q.sid; save(SID_KEY, sid); }
    else sid = load(SID_KEY);

    token = token || load(TOKEN_KEY);

    // 有 token 就顺带确认一下（能回看已关闭场次）；没有/失效也照样按公开模式往下走
    var staffSid = '';
    var check = token
      ? fetch('/api/staff-check?token=' + encodeURIComponent(token))
          .then(function (r) { return r.json(); })
          .then(function (d) { return d && d.ok ? d : null; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    check.then(function (d) {
      if (!d) {
        setToken('');                  // 令牌失效：静默丢弃，不弹任何提示
      } else {
        sessions = d.sessions || [];
        staffSid = d.sid || '';
        renderSessions();
      }
      return refreshSessions();
    }).then(function () {
      var next = pickSession(sid || staffSid);
      if (!next) { showNoSession(); scheduleIdleRetry(); return; }
      if (next !== sid) { switchTo(next); return; }
      startStream();
      poll();
    });
  }

  /** 没有任何进行中场次时：每 5 秒查一次，等工作人员开场后自动接上 */
  function scheduleIdleRetry() {
    setTimeout(function () {
      refreshSessions().then(function () {
        var next = pickSession('');
        if (next) { switchTo(next); return; }
        scheduleIdleRetry();
      });
    }, 5000);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && sid) { startStream(); poll(); }
  });

  applyStaticI18n();
  bootstrap();
})();
