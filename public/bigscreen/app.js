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

  var cards = new Map();  // pid -> { el, refs, sig, submitted, oddEven, number }
  var events = [];        // 最近动态（只保留 8 条，够看就行）

  var t = window.I18N.t;
  var $ = function (id) { return document.getElementById(id); };
  var grid = $('grid');

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
    $('empty').classList.add('on');
    $('empty').textContent = t('bs_noSession');
  }

  function resetBoard() {
    cards.forEach(function (c) { c.el.remove(); });
    cards.clear();
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
    applyDensity(total);
  }

  /** 卡片密度：按「一行能舒服放下几张」推算，人少放大、人多收窄，尽量把屏幕用满 */
  var lastCount = 0;
  function applyDensity(n) {
    lastCount = n;
    var w = grid.clientWidth || 1200;
    var cols = Math.max(1, Math.floor(w / 300));
    var d = n <= cols * 3 ? 'sparse' : (n <= cols * 6 ? 'normal' : 'dense');
    if (grid.getAttribute('data-density') !== d) grid.setAttribute('data-density', d);
  }

  window.addEventListener('resize', function () { applyDensity(lastCount); });

  /* ---------- 渲染：玩家卡片（按 pid 增量 diff） ---------- */
  function stateOf(p) {
    if (p.submitted) return 'picked';
    return p.status === 'draft' ? 'draft' : 'unpicked';
  }

  function sigOf(p) {
    return [p.status || '', p.oe || '', p.num == null ? '' : p.num].join('|');
  }

  function makeCard(p, d) {
    var el = document.createElement('article');
    el.className = 'pc';
    el.setAttribute('data-pid', p.id);

    var top = document.createElement('div');
    top.className = 'pc-top';
    if (p.seatNo) {                       // 席位号：现场按座位找人，比脱敏会员号直观
      var seatEl = document.createElement('span');
      seatEl.className = 'pc-seat';
      seatEl.textContent = '#' + p.seatNo;
      top.appendChild(seatEl);
    }
    var idEl = document.createElement('span');
    idEl.className = 'pc-id';
    idEl.textContent = p.maskedId || p.id;   // 只展示脱敏标签，明文会员号不下发到浏览器
    idEl.title = p.maskedId || p.id;
    top.appendChild(idEl);
    var vet = document.createElement('span');
    vet.className = 'pc-vet';
    vet.textContent = t('bs_vet');
    top.appendChild(vet);

    var body = document.createElement('div');
    body.className = 'pc-body';

    // 单双：与玩家端 .pair .opt 一一对应（两枚都画出来，只把选中的点亮）
    var oeWrap = document.createElement('div');
    oeWrap.className = 'pc-oe';
    var oeRefs = [];
    ['单', '双'].forEach(function (v) {
      var b = document.createElement('span');
      b.setAttribute('data-oe', v);
      b.textContent = t(v === '单' ? 'odd' : 'even');
      oeWrap.appendChild(b);
      oeRefs.push(b);
    });

    // 数字：与玩家端 #numGrid 同一个 .numgrid（5 列 × 2 行，0–9 顺序一致）
    var numWrap = document.createElement('div');
    numWrap.className = 'numgrid pc-numgrid';
    var cellRefs = [];
    for (var i = 0; i < 10; i++) {
      var c = document.createElement('span');
      c.setAttribute('data-n', String(i));
      c.textContent = String(i);
      numWrap.appendChild(c);
      cellRefs.push(c);
    }

    body.appendChild(oeWrap);
    body.appendChild(numWrap);

    var foot = document.createElement('div');
    foot.className = 'pc-foot';
    var dot = document.createElement('span');
    dot.className = 'd';
    foot.appendChild(dot);

    el.appendChild(top);
    el.appendChild(body);
    el.appendChild(foot);

    var card = { el: el, refs: { id: idEl, vet: vet, oe: oeRefs, cells: cellRefs, foot: foot }, sig: '', locked: false };
    paintCard(card, p, d);
    return card;
  }

  /** 把一份玩家数据画到卡片上（d = 当前状态负载，含 locked / number 用于命中标记）
   *  选择结果全部用图示表达：单双两枚 + 0–9 十格，选中的那格点亮，不做文字拼读。 */
  function paintCard(card, p, d) {
    card.el.setAttribute('data-state', stateOf(p));
    card.refs.vet.style.display = p.isVeteran ? '' : 'none';

    // oe/num 是「当前显示值」：已确认取提交值，未确认取草稿值（服务端算好，前端不猜）
    var oe = (p.oe === '单' || p.oe === '双') ? p.oe : null;
    var num = (p.num == null || p.num === '') ? null : Number(p.num);
    var locked = !!(d && d.locked && d.number != null);
    var judged = locked && !!p.submitted;   // 只有已确认的提交才判命中，草稿不判
    var oeHit = judged && oe !== null && (oe === '单') === (d.number % 2 === 1);

    // 单双两枚：选中 → .sel；开奖后判中/未中 → .hit/.miss（描边颜色由 CSS 决定）
    card.refs.oe.forEach(function (el) {
      var mine = oe !== null && el.getAttribute('data-oe') === oe;
      el.classList.toggle('sel', mine);
      el.classList.toggle('hit', mine && oeHit);
      el.classList.toggle('miss', mine && judged && !oeHit);
      el.textContent = t(el.getAttribute('data-oe') === '单' ? 'odd' : 'even');
    });

    // 数字十格：选中格点亮；开奖后同样用描边标出中/未中
    card.refs.cells.forEach(function (el) {
      var n = Number(el.getAttribute('data-n'));
      var mine = num !== null && n === num;
      el.classList.toggle('sel', mine);
      el.classList.toggle('hit', mine && judged && d.number === n);
      el.classList.toggle('miss', mine && judged && d.number !== n);
    });

    // 状态行只留一句状态（命中与否已经画在选项上，不再重复文字）
    var foot = card.refs.foot;
    while (foot.children.length > 1) foot.removeChild(foot.lastChild);
    var st = document.createElement('span');
    st.textContent = t(p.submitted ? 'bs_statePicked'
      : p.status === 'draft' ? 'bs_stateDraft'
      : 'bs_stateUnpicked');
    foot.appendChild(st);

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

  function syncCards(list, d) {
    var seen = Object.create(null);
    list.forEach(function (p) {
      seen[p.id] = 1;
      var card = cards.get(p.id);
      if (!card) {
        card = makeCard(p, d);
        cards.set(p.id, card);
        grid.appendChild(card.el);
        if (hasBaseline) { pushEvent('join', p.id); flash(card.el, 'enter'); }
        return;
      }
      var next = sigOf(p);
      // 开奖/撤销开奖不改变选择签名，但要让命中标记重新画一遍，所以单列一个判断
      var lockedChanged = (d && d.locked ? 1 : 0) !== (card.locked ? 1 : 0);
      if (card.sig === next && !lockedChanged) return;
      var prev = { submitted: card.submitted, oddEven: card.oddEven, number: card.number };
      paintCard(card, p, d);
      if (hasBaseline) {
        if (p.submitted && !prev.submitted) pushEvent('pick', p.id);
        else if (p.submitted && prev.submitted && (p.oddEven !== prev.oddEven || p.number !== prev.number)) pushEvent('change', p.id);
      }
      flash(card.el, 'change');
    });

    // 不在本帧里的：本轮已重置或玩家被移除，整条移除，避免残留过期数据
    cards.forEach(function (card, pid) {
      if (seen[pid]) return;
      card.el.remove();
      cards.delete(pid);
      if (hasBaseline) pushEvent('leave', pid);
    });

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
      cards.forEach(function (c) { c.el.remove(); });
      cards.clear();
      pushEvent('round', d.round);   // 新一轮：整屏清空，只留一条「第 N 轮开始」
    }
    curRound = d.round;

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
