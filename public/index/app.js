/* index 页面逻辑 —— 自原 index.html 内联 <script> 原样抽出 */
(function () {
  'use strict';
  /* 场次绑定：验证口令后由服务端签发令牌，本地只保存 { sid, ut, exp }。
     口令本身从不落地（不写 localStorage、不进 URL、不回显）。 */
  var BIND_KEY = 'oe_bind';
  var PID_PREFIX = 'oe_pid:';    // 每个场次独立记住自己的身份：oe_pid:<sid>
  /* 连点合并窗口：停手 250ms 后才上报，只发最后一次。
     注意与服务端 server.js 的 DRAFT_BCAST_MS（广播合并窗口）是两回事，不要合并成一个值。 */
  var DRAFT_DEBOUNCE_MS = 250;

  /** 读取本地绑定，过期或结构不对一律视为无绑定 */
  function loadBind() {
    try {
      var raw = localStorage.getItem(BIND_KEY);
      if (!raw) return null;
      var b = JSON.parse(raw);
      if (!b || !b.sid || !b.ut) return null;
      if (b.exp && Number(b.exp) <= Date.now()) { localStorage.removeItem(BIND_KEY); return null; }
      return { sid: String(b.sid), ut: String(b.ut), exp: Number(b.exp) || 0 };
    } catch (e) { return null; }
  }

  var bind = loadBind();
  var sid = bind ? bind.sid : '';
  var ut = bind ? bind.ut : '';
  var pid = '';
  var sessList = [];             // 服务端返回的进行中场次
  var state = null;
  var picking = false;           // 是否正在展开场次选择（切换时不打断当前场次）
  var selOE = null, selNum = null, submitting = false;

  /* ---------- 临时选择（草稿）的本地状态 ----------
   * 点选即上报给服务端（大屏实时看到），但「点选」不等于参赛，必须按按钮确认提交。
   * 草稿服务端只存内存，所以本地必须留一份：刷新/断线/换网后靠它把最后的选择补发上去，
   * 保证「最终一致」而不是「每次点击都必达」。
   */
  var draftTimer = 0;          // 500ms 合并窗口
  var draftConfirmed = null;   // 服务端已确认收到的 { oe, num }
  var draftSending = false;    // 串行化，避免两个请求在途互相覆盖

  function draftStoreKey() { return 'oe_draft:' + sid; }
  function seqStoreKey() { return 'oe_seq:' + sid; }
  function idemStoreKey() { return 'oe_idem:' + sid; }

  function readLocalDraft() {
    try {
      var raw = localStorage.getItem(draftStoreKey());
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.oe || d.num == null) return null;
      return { oe: d.oe, num: Number(d.num), seq: Number(d.seq) || 0, round: Number(d.round) || 0 };
    } catch (e) { return null; }
  }

  function writeLocalDraft(d) {
    try { localStorage.setItem(draftStoreKey(), JSON.stringify(d)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function dropLocalDraft() {
    draftConfirmed = null;
    try { localStorage.removeItem(draftStoreKey()); } catch (e) { /* 忽略 */ }
  }

  /** 单调序号：跨刷新只增不减，服务端据此丢弃乱序/重发的旧值 */
  function nextDraftSeq() {
    var n = 0;
    try { n = parseInt(localStorage.getItem(seqStoreKey()), 10) || 0; } catch (e) { n = 0; }
    n += 1;
    try { localStorage.setItem(seqStoreKey(), String(n)); } catch (e) { /* 忽略 */ }
    return n;
  }

  function ensureIdemKey() {
    var k = '';
    try { k = localStorage.getItem(idemStoreKey()) || ''; } catch (e) { k = ''; }
    if (k) return k;
    k = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(idemStoreKey(), k); } catch (e) { /* 忽略 */ }
    return k;
  }

  function clearIdemKey() {
    try { localStorage.removeItem(idemStoreKey()); } catch (e) { /* 忽略 */ }
  }

  /** 某场次下本机保存的玩家身份 key */
  function pidKey(s) { return PID_PREFIX + (s || ''); }

  window.I18N.init({ storageKey: 'oe_lang' });
  var t = window.I18N.t;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- i18n ---------- */
  /* 语言码 → 按钮短标签 */
  var LANG_LABEL = { 'zh-HK': '繁體', 'zh-CN': '简体', 'en-US': 'EN' };

  /* 静态文案应用 + 语言按钮标签 + 单双选项文字 + 动态区重渲染 */
  function applyI18n() {
    var lang = window.I18N.getLocale();
    document.documentElement.lang = lang;

    // 语言按钮上的短标签
    var code = $('langCode');
    if (code) code.textContent = LANG_LABEL[lang] || lang;

    // data-i18n 文本
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      var key = el.getAttribute('data-i18n');
      // 若元素内部含 <b> 或嵌套标签，用 innerHTML 保留结构
      var val = t(key);
      if (/<[a-z][\s\S]*>/i.test(val)) el.innerHTML = val;
      else el.textContent = val;
    });

    // data-i18n-ph 占位符
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });

    // 单双选项按钮文字
    Array.prototype.forEach.call(document.querySelectorAll('.pair .opt'), function (b) {
      var oe = b.getAttribute('data-oe');
      var main = b.querySelector('.oe-main');
      if (main) main.textContent = t(oe === '单' ? 'odd' : 'even');
    });

    // 页面标题
    document.title = t('p_title') + ' · ' + t('p_tag');

    // 动态区重新渲染
    render();

    // 规则层正在展示时，语言切换后立刻重绘倒计时文案（不等下一帧）
    if (rulesOpen()) { rulesLastSec = -1; paintRules(rulesEndAt - Date.now()); }

    // 切换摄像头按钮的 aria/title 也随语言更新
    updateCamSwitchUI();
  }

  /* ---------- Toast ---------- */
  var toastTimer = null;
  function toast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2600);
  }

  function esc(x) {
    return String(x).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  /* ---------- 玩家端规则介绍（登录成功后自动展示 10 秒） ----------
     触发点只有一个：扫码/手动登记成功（handleScannedContent）。
     同一身份在本次页面里最多展示一次；刷新页面（已有本地身份）不会重放。
     关闭方式：点击任意区域立即关闭，或倒计时结束自动关闭。
     关闭后遮罩从布局与点击链路中彻底移除，不影响后续扫码/预测/语言切换。 */
  var RULES_MS = 10000;
  var rulesEndAt = 0;        // 本轮展示的结束时间戳（ms）
  var rulesRemain = 0;       // 切到后台时暂存的剩余毫秒
  var rulesRaf = 0;          // rAF 句柄
  var rulesLastSec = -1;     // 上次渲染的秒数（避免每帧重写文本）
  var rulesPaused = false;   // 页面隐藏时暂停倒计时
  var rulesClosing = false;  // 正在淡出
  var rulesShownFor = '';    // 已展示过规则的身份，防止重复触发
  var rulesSeq = 0;          // 展示序号：用于丢弃上一次淡出的延迟收尾

  function rulesEl() { return $('rulesMask'); }

  function rulesOpen() {
    var m = rulesEl();
    return !!m && !m.classList.contains('hidden') && !rulesClosing;
  }

  /** 渲染倒计时文案与底部细条宽度 */
  function paintRules(remain) {
    var ms = Math.max(0, remain);
    var sec = Math.ceil(ms / 1000);
    if (sec !== rulesLastSec) {
      rulesLastSec = sec;
      $('rulesTime').textContent = t('p_rulesCountdown', { n: sec });
    }
    $('rulesBarFill').style.transform = 'scaleX(' + (ms / RULES_MS).toFixed(4) + ')';
  }

  function rulesTick() {
    rulesRaf = 0;
    if (!rulesOpen() || rulesPaused) return;
    var remain = rulesEndAt - Date.now();
    if (remain <= 0) { closeRules(); return; }
    paintRules(remain);
    rulesRaf = requestAnimationFrame(rulesTick);
  }

  function scheduleRules() {
    if (rulesRaf) cancelAnimationFrame(rulesRaf);
    rulesRaf = requestAnimationFrame(rulesTick);
  }

  /** 展示规则：pidForRules 变化才会再展示一次。返回 true 表示确实展示了 */
  function startRules(pidForRules) {
    if (!pidForRules) return false;
    if (rulesShownFor === pidForRules) return false;
    if (rulesOpen()) return false;
    rulesShownFor = pidForRules;

    var m = rulesEl();
    rulesSeq++;
    rulesClosing = false;
    rulesPaused = false;
    rulesLastSec = -1;
    rulesEndAt = Date.now() + RULES_MS;
    paintRules(RULES_MS);

    m.classList.remove('hidden', 'out');
    void m.offsetWidth;              // 强制回流，保证淡入过渡生效
    m.classList.add('show');
    m.removeAttribute('aria-hidden');
    scheduleRules();
    return true;
  }

  /** 关闭规则（点击或倒计时结束共用）：先解除点击拦截，再淡出并隐藏 */
  function closeRules() {
    var m = rulesEl();
    if (!m || m.classList.contains('hidden') || rulesClosing) return;
    rulesClosing = true;
    var seq = ++rulesSeq;
    if (rulesRaf) { cancelAnimationFrame(rulesRaf); rulesRaf = 0; }
    m.classList.remove('show');
    m.classList.add('out');          // out 带 pointer-events:none，立刻不再拦截点击
    m.setAttribute('aria-hidden', 'true');
    setTimeout(function () {
      if (seq !== rulesSeq) return;  // 期间又重新展示过，交给新一轮管理
      m.classList.add('hidden');
      m.classList.remove('out');
      rulesClosing = false;
    }, 220);
  }

  /** 页面隐藏/恢复时暂停与续算倒计时，避免玩家没看到就被关掉 */
  function pauseRules() {
    if (!rulesOpen() || rulesPaused) return;
    rulesPaused = true;
    rulesRemain = Math.max(0, rulesEndAt - Date.now());
    if (rulesRaf) { cancelAnimationFrame(rulesRaf); rulesRaf = 0; }
  }

  function resumeRules() {
    if (!rulesOpen() || !rulesPaused) return;
    rulesPaused = false;
    rulesEndAt = Date.now() + rulesRemain;
    scheduleRules();
  }

  rulesEl().addEventListener('click', function () { closeRules(); });

  /* ---------- 状态判定 ---------- */
  function phase(s) {
    if (!sid) return 'pick';                   // 还没选场次（或本场已结束被清空）
    if (!s || !s.me) return 'unreg';           // 未扫码（或新一轮）
    if (s.me.oddEven == null) return 'ready';  // 已登记待预测
    if (!s.locked) return 'wait';              // 已预测等待开奖
    return 'done';                             // 已出结果
  }

  var PHASE_META = {
    pick:  { cls: 'st-unreg', text: function () { return t('p_pickTitle'); } },
    unreg: { cls: 'st-unreg', text: function () { return t('p_st_unreg'); } },
    ready: { cls: 'st-ready', text: function () { return t('p_st_ready'); } },
    wait:  { cls: 'st-wait',  text: function () { return t('p_st_wait'); } },
    done:  { cls: 'st-done',  text: function () { return t('p_st_done'); } }
  };

  /* ---------- 渲染 ---------- */
  function render() {
    var s = state;

    // 身份有效性判定：唯一权威信号是服务端 players 里是否还有这个 pid（s.me 是否非空）。
    // 服务端 /api/reset 开始新一轮时会清空 players，此时 s.me 变 null，即为「身份失效，需重新扫码」。
    // 注意必须是 `s && !s.me`：首帧还没到时 s 是 null，那不是「身份失效」，清掉 pid 会让
    // 刷新页面 = 被登出（草稿也一起丢）。等服务端明确说「本轮没这个人」再清。
    if (sid && pid && s && !s.me) { pid = ''; localStorage.removeItem(pidKey(sid)); }

    var ph = phase(s);
    var meta = PHASE_META[ph];
    $('statusPill').className = 'status-pill ' + meta.cls;
    $('statusText').textContent = meta.text();

    // 场次 + 轮次标题（未选场次时留空）
    $('roundInfo').textContent = (sid && s)
      ? t('p_sessionRound', { name: s.session.name, n: s.round }) + (s.locked ? t('p_locked') : t('p_inProgress'))
      : '';

    $('cardSession').classList.toggle('hidden', !(picking || ph === 'pick'));
    $('cardScan').classList.toggle('hidden', picking || ph !== 'unreg');
    $('cardPred').classList.toggle('hidden', picking || ph !== 'ready');
    $('cardWait').classList.toggle('hidden', picking || ph !== 'wait');
    $('cardResult').classList.toggle('hidden', picking || ph !== 'done');

    // 提交成功后按钮会保持 disabled 防重复提交；下一轮重新登记时必须恢复可点，
    // 否则同一页面连玩多轮的玩家会卡在「选项都选了但按钮点不动」。
    if (ph === 'ready') $('predBtn').disabled = false;

    // 切换态下给出「取消」出口，避免卡在选择界面
    var cancel = $('sessCancel');
    if (cancel) cancel.classList.toggle('hidden', !(picking && sid));

    // 顶栏按钮：选了场次才能切换；有本地身份才能登出
    $('switchSessBtn').classList.toggle('hidden', !sid || picking);
    $('logoutBtn').classList.toggle('hidden', !pid || picking);

    if (ph === 'wait') {
      $('myPred').innerHTML =
        '<div class="chip">' + esc(t('p_oeCol')) + ' <b>' + esc(s.me.oddEven) + '</b></div>' +
        '<div class="chip">' + esc(t('p_numCol')) + ' <b>' + esc(s.me.number) + '</b></div>';
    }

    if (ph === 'done') renderResult(s);
  }

  function renderResult(s) {
    var n = s.number;
    $('resultNum').textContent = n;

    var me = s.me;
    // 单双命中：基于开奖数字的奇偶性判定，与语言/文案无关（避免「单/單」「双/雙」字形差异导致误判）
    var oeHit = (me.oddEven === '单') === (n % 2 === 1);
    var numHit = me.number === n;
    $('vOE').className = 'v ' + (oeHit ? 'hit' : 'miss');
    $('vOEd').innerHTML = verdictHtml(me.oddEven, oeHit);
    $('vNum').className = 'v ' + (numHit ? 'hit' : 'miss');
    $('vNumd').innerHTML = verdictHtml(me.number, numHit);

    // 奖品档位按「两种猜测的命中组合」判定，四种情况一一对应（互斥、无优先级歧义）：
    //   都中 → both ｜ 只中数字 → number ｜ 只中单双 → oddeven ｜ 都没中 → miss
    // 单双与数字是两次独立猜测，猜「单」+ 数字 8 可以数字中而单双错，所以必须分开判。
    renderPrize(s, numHit ? (oeHit ? 'both' : 'number') : (oeHit ? 'oddeven' : 'miss'));
    renderBonus(s);
  }

  /**
   * 渲染全员额外奖励。触发条件来自服务端快照（s.bonus.triggered 表示本轮开奖命中特殊数字），
   * 与个人档位无关：无论是否猜中，只要本轮触发了就显示。文案取 s.bonus 的 title/desc（三语对象），
   * 按玩家当前语言取对应那一份，留空时回落内置文案。
   */
  function renderBonus(s) {
    var box = $('bonusBox');
    if (!box) return;
    var b = s.bonus || {};
    var triggered = !!b.triggered;
    box.classList.toggle('hidden', !triggered);
    if (!triggered) return;
    var title = localizedText(b.title) || t('p_bonusDefTitle');
    var desc = localizedText(b.desc);
    $('bonusTitle').textContent = title;
    $('bonusDesc').textContent = desc;
    $('bonusDesc').classList.toggle('hidden', !desc);
  }

  /* 单项预测的两行结构：上面是猜的值，下面是命中结论（✓ 命中 / ✗ 未中） */
  function verdictHtml(value, hit) {
    return '<span class="pval">' + esc(String(value == null ? '—' : value)) + '</span>' +
           '<span class="pres">' + esc(hit ? t('p_hitYes') : t('p_hitNo')) + '</span>';
  }

  /* 奖品档位 → 档位标签（文案由 i18n 提供，三语各一份） */
  var PRIZE_LABEL = {
    both: 'p_prizeTierBoth',
    number: 'p_prizeTierNumber',
    oddeven: 'p_prizeTierOddeven',
    miss: 'p_prizeTierMiss'
  };

  /* 奖品文案的三语字段：服务端存 { 'zh-CN': '', 'zh-HK': '', 'en-US': '' }，
   * 这里按玩家当前语言取对应那一份。 */
  var PRIZE_LOCALES = ['zh-CN', 'zh-HK', 'en-US'];

  /**
   * 取某个奖品字段在当前语言下的文案。
   * 先取玩家选的语言，没有就按固定顺序回退（简 → 繁 → 英）——后台某一种语言漏填时
   * 玩家看到的是别的语言的同一条奖品，而不是空白。旧版单语字符串同样兼容。
   */
  function localizedText(field) {
    if (!field) return '';
    if (typeof field === 'string') return String(field).trim();   // 旧版单语数据
    var cur = window.I18N.getLocale();
    var order = [cur].concat(PRIZE_LOCALES);
    for (var i = 0; i < order.length; i += 1) {
      var v = field[order[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  /**
   * 判断某一档奖品是否「有效配置」：必须是对象，且奖品名称有内容（任一语言非空）。
   * 空配置、结构异常（非对象/数组/字段类型不对）、只有说明没有名称，一律视为未配置。
   */
  function hasValidPrize(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
    return !!localizedText(cfg.title);
  }

  /**
   * 渲染结果奖品。prizes 来自服务端快照（管理界面保存后随 SSE 即时下发）。
   * 只有该档奖品确实配置了有效内容才显示 prizeBox；未配置/为空/结构异常时
   * 整个卡片隐藏（连带清空残留文案），其余结果信息照常展示。
   */
  function renderPrize(s, tier) {
    var box = $('prizeBox');
    if (!box) return;
    var cfg = (s && s.prizes && s.prizes[tier]) || null;

    // 非法/空配置：隐藏卡片并清空上一次渲染的文本，避免残留可见
    if (!hasValidPrize(cfg)) {
      box.classList.add('hidden');
      $('prizeTier').textContent = '';
      $('prizeTitle').textContent = '';
      $('prizeDesc').textContent = '';
      $('prizeDesc').classList.add('hidden');
      return;
    }

    var title = localizedText(cfg.title);
    var desc = localizedText(cfg.desc);
    $('prizeTier').textContent = t(PRIZE_LABEL[tier]);
    $('prizeTitle').textContent = title;
    $('prizeDesc').textContent = desc;
    $('prizeDesc').classList.toggle('hidden', !desc);
    box.className = 'prize' + (tier === 'miss' ? ' miss' : '');
  }

  /* ---------- 网络（SSE 实时推送 + 断线重连） ---------- */
  var es = null;          // EventSource 实例
  var streamClosed = false; // 手动关闭标记（登出/页面隐藏时置 true，避免误判为断线）
  var streamErrs = 0;     // 连续连接失败次数（用于触发准入复核）

  function fetchState() {
    if (!sid) return Promise.resolve({ ok: false });
    var url = '/api/state?sid=' + encodeURIComponent(sid) +
      (ut ? '&ut=' + encodeURIComponent(ut) : '') +
      (pid ? '&pid=' + encodeURIComponent(pid) : '');
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }

  function applyState(s) {
    if (!s || !s.ok) return;
    // 场次已被关闭：退回场次选择（正常情况下服务端会先推 session_closed 事件）
    if (s.session && s.session.status === 'closed') { onSessionClosed(); return; }
    $('connLost').classList.add('hidden');
    var prevPh = state ? phase(state) : null;
    state = s;
    render();
    resumeDraft(s);
    if (prevPh === 'wait' && phase(s) === 'done') toast(t('p_resultLab') + ' 🎉', 'ok');
  }

  /** 关闭当前 SSE 连接（手动/重连前统一走这里，避免遗留连接）。 */
  function closeStream() {
    streamClosed = true;
    if (es) { es.close(); es = null; }
  }

  /** 建立 SSE 连接：订阅当前场次，pid 变化或切换场次时重连。
   *  连接同样要带绑定令牌，否则服务端拒连——避免有人手工拼 URL 偷看别场。 */
  function startStream() {
    closeStream();
    if (!sid) return;
    streamClosed = false;
    var url = '/api/stream?sid=' + encodeURIComponent(sid) +
      (ut ? '&ut=' + encodeURIComponent(ut) : '') +
      (pid ? '&pid=' + encodeURIComponent(pid) : '');
    es = new EventSource(url);

    // 连接建立（含自动重连成功）：立即拉一次全量状态对齐，消除断线期间错过的变更
    es.onopen = function () {
      streamErrs = 0;
      $('connLost').classList.add('hidden');
      fetchState().then(function (d) {
        if (handleAuthFail(d)) return;
        applyState(d);
      }).catch(function () {});
    };

    // 服务端推送的本场次状态快照（事件名 state）
    es.addEventListener('state', function (ev) {
      try { applyState(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    });

    // 场次被工作人员关闭：提示并退回场次选择
    es.addEventListener('session_closed', function (ev) {
      var d = {};
      try { d = JSON.parse(ev.data) || {}; } catch (e) { /* 忽略坏帧 */ }
      if (d.sid && d.sid !== sid) return;
      onSessionClosed();
    });

    // 心跳事件：无需处理，仅用于保持连接活性（浏览器层面已处理）

    // 连接出错/中断：显示提示；EventSource 会按服务端 retry 间隔自动重连，
    // 重连成功后 onopen 再次触发并全量对齐
    es.onerror = function () {
      if (streamClosed) return; // 手动关闭导致的 error 不提示
      streamErrs++;
      // readyState 为 CONNECTING 表示正在重连；CLOSED 才彻底失败
      if (es && es.readyState === EventSource.CONNECTING) {
        $('connLost').classList.remove('hidden');
      }
      // 连续失败若干次后主动核对一次准入结果：
      // 若绑定已失效（令牌过期/场次关闭），服务端会返回 403/409，这里据此退回选择界面，
      // 避免对着一个永远连不上的场次无限重连。
      if (streamErrs >= 3) { streamErrs = 0; poll(); }
    };
  }

  /** 拉取一次全量状态快照，用于对齐 SSE 断线/回到前台期间错过的变更。 */
  function poll() {
    if (!sid) return;
    fetchState().then(function (d) {
      if (handleAuthFail(d)) return;
      applyState(d);
    }).catch(function () {
      $('connLost').classList.remove('hidden');
    });
  }

  /** 统一的准入失败处理：绑定失效 / 场次关闭 → 清掉本地绑定并回到选择界面。
   *  返回 true 表示已经处理（调用方不要再渲染状态）。 */
  function handleAuthFail(d) {
    if (!d || d.ok !== false) return false;
    if (d.code === 'session_closed') { onSessionClosed(); return true; }
    if (d.code === 'session_need_unlock' || d.code === 'session_locked' || d.code === 'session_not_found') {
      requirePick('p_err_need_unlock');
      return true;
    }
    return false;
  }

  /* ---------- 场次（口令验证 / 选择 / 切换 / 关闭后的回退） ---------- */

  var sessNeedPassword = false;   // 服务端告知：当前是否需要口令才能入场

  /** 拉取进行中的场次列表，并渲染选择卡 */
  function loadSessions() {
    return fetch('/api/sessions', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        sessList = (d && d.sessions) || [];
        sessNeedPassword = !!(d && d.needPassword);
        renderSessionPick();
        return sessList;
      })
      .catch(function () {
        sessList = [];
        renderSessionPick();
        return sessList;
      });
  }

  function renderSessionPick() {
    var box = $('sessPick');
    if (!sessList.length) {
      box.innerHTML = '<div class="hint" style="margin:0">' + esc(t('p_noSession')) + '</div>';
      return;
    }
    box.innerHTML = sessList.map(function (s) {
      var meta = t('p_round', { n: s.round }) + (s.locked ? t('p_locked') : t('p_inProgress'));
      var cur = s.id === sid ? ' cur' : '';
      return '<button class="sess-opt' + cur + '" type="button" data-sid="' + esc(s.id) + '">' +
        '<span class="so-main">' + esc(s.name) +
        '<span class="so-meta">' + esc(meta) + '</span></span>' +
        '<span class="so-go">' + (cur ? '✓' : '›') + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.sess-opt'), function (b) {
      b.addEventListener('click', function () { chooseSession(b.getAttribute('data-sid')); });
    });
  }

  /** 清空预测区的勾选（切换场次时避免把上一场的选项带过去） */
  function clearPredSelection() {
    Array.prototype.forEach.call(document.querySelectorAll('.pair .opt'), function (x) { x.classList.remove('sel'); });
    Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (x) { x.classList.remove('sel'); });
    $('predErr').textContent = '';
  }

  /** 清掉本地场次绑定（只清 sid/令牌，不碰各场次记住的身份） */
  function clearBind() {
    sid = '';
    ut = '';
    bind = null;
    pid = '';
    state = null;
    try { localStorage.removeItem(BIND_KEY); } catch (e) { /* 隐私模式忽略 */ }
  }

  /** 点选某个场次：已绑定的同一场次直接收起；其他场次必须先过口令 */
  function chooseSession(id) {
    if (!id) return;
    if (id === sid && ut) { picking = false; render(); return; }
    openPwModal(id);
  }

  /* ----- 口令弹层 ----- */

  var pwTarget = '';   // 当前正在验证的场次

  function sessionName(id) {
    for (var i = 0; i < sessList.length; i++) if (sessList[i].id === id) return sessList[i].name;
    return id;
  }

  function openPwModal(id) {
    pwTarget = id;
    $('pwSess').textContent = sessionName(id);
    $('pwInput').value = '';
    $('pwErr').textContent = '';
    $('pwBtn').disabled = false;
    $('pwMask').classList.add('show');
    setTimeout(function () { try { $('pwInput').focus(); } catch (e) { /* 忽略 */ } }, 120);
  }

  function closePwModal() {
    $('pwMask').classList.remove('show');
    $('pwInput').value = '';
    $('pwErr').textContent = '';
    pwTarget = '';
  }

  /** 调服务端校验口令；成功返回绑定令牌（口令只在这次请求里出现，不落地） */
  function unlock(id, password) {
    var body = password ? { sid: id, password: password } : { sid: id, auto: true };
    return fetch('/api/session-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /** 应用绑定：本地只写 sid + 令牌 + 过期时间，然后复位界面、重连 */
  function applyBind(d) {
    sid = d.sid;
    ut = d.ut;
    bind = { sid: d.sid, ut: d.ut, exp: Number(d.expiresAt) || 0 };
    try { localStorage.setItem(BIND_KEY, JSON.stringify(bind)); } catch (e) { /* 忽略 */ }
    pid = localStorage.getItem(pidKey(sid)) || '';
    state = null;
    selOE = null; selNum = null;
    picking = false;
    clearPredSelection();
    $('scanErr').textContent = '';
    render();
    startStream();
    poll();
  }

  function submitPw() {
    if (!pwTarget) return;
    var pwd = $('pwInput').value;
    if (!pwd) { $('pwErr').textContent = t('p_err_pw_empty'); $('pwInput').focus(); return; }
    $('pwBtn').disabled = true;
    $('pwErr').textContent = '';
    unlock(pwTarget, pwd).then(function (d) {
      $('pwBtn').disabled = false;
      if (!d || !d.ok) {
        $('pwErr').textContent = window.I18N.errCode(d && d.code, d, 'p_err_') || t('p_err_pw_fail');
        try { $('pwInput').select(); } catch (e) { /* 忽略 */ }
        return;
      }
      var name = d.session && d.session.name ? d.session.name : sessionName(d.sid);
      closePwModal();
      applyBind(d);
      toast(t('p_toast_sessionIn', { name: name }), 'ok');
    }).catch(function () {
      $('pwBtn').disabled = false;
      $('pwErr').textContent = t('p_scanNetErr');
    });
  }

  /** 单场次场景：免口令自动绑定（服务端只在「唯一进行中」时允许） */
  function autoBind(id) {
    unlock(id, '').then(function (d) {
      if (d && d.ok) { applyBind(d); return; }
      // 期间又开出别的场次 → 转为要求输入口令
      clearBind();
      picking = false;
      render();
      loadSessions().then(function () { openPwModal(id); });
    }).catch(function () {
      clearBind();
      render();
    });
  }

  /** 绑定失效 / 需要重新验证：清绑定并回到选择界面 */
  function requirePick(msgKey) {
    closeStream();
    clearBind();
    picking = false;
    render();
    loadSessions();
    if (msgKey) toast(t(msgKey), 'err');
  }

  /** 场次被关闭（或已失效）：回到场次选择 */
  function onSessionClosed() {
    if (!sid) return;
    closeStream();
    clearBind();
    picking = false;
    render();
    toast(t('p_sessionClosed'), 'err');
    loadSessions();
  }

  /** 启动时决定进入哪个场次：
   *  本地已有有效绑定 → 直接沿用（刷新 / 重开页面都不再询问，也不允许改场）；
   *  无绑定 → 唯一场次自动绑定，多场并行则要求先输口令。 */
  function bootstrap() {
    var urlSid = '';
    try { urlSid = new URLSearchParams(location.search).get('s') || ''; } catch (e) { urlSid = ''; }

    if (bind && bind.sid) {
      sid = bind.sid;
      ut = bind.ut;
      pid = localStorage.getItem(pidKey(sid)) || '';
      render();
      startStream();
      fetchState().then(function (d) {
        if (handleAuthFail(d)) return;
        applyState(d);
      }).catch(function () { /* 断网时由 SSE 重连兜底 */ });
      return;
    }

    loadSessions().then(function (list) {
      if (!list.length) { clearBind(); render(); return; }
      if (list.length === 1) { autoBind(list[0].id); return; }

      clearBind();
      render();
      if (urlSid && list.some(function (s) { return s.id === urlSid; })) {
        openPwModal(urlSid);          // 带 ?s= 的入口：直接对准该场次索要口令
      } else {
        toast(t('p_needPw'), 'err');
      }
    });
  }

  /* ---------- 扫码识别（手动输入通道） ---------- */
  function handleScannedContent(content) {
    $('scanErr').textContent = '';
    if (!sid) { $('scanErr').textContent = t('p_pickHint'); return; }
    fetch('/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, sid: sid, ut: ut })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) {
        if (handleAuthFail(d)) return;
        $('scanErr').textContent = window.I18N.errCode(d.code, d, 'p_err_') || t('p_scanFail');
        return;
      }
      pid = d.pid;
      localStorage.setItem(pidKey(sid), pid);
      // 登录成功 → 展示规则介绍（10 秒 / 点击即关）；规则层已占用全屏时不再叠 toast
      if (!startRules(pid)) toast(t('p_welcome', { n: d.pid }), 'ok');
      startStream(); // pid 变化，重连以获取 me 视角
      poll();
    }).catch(function () { $('scanErr').textContent = t('p_scanNetErr'); });
  }

  /* ---------- 相机扫码 ---------- */
  var DEFAULT_FACING = 'user';  // 默认前置摄像头（扫自己手上的二维码）
  var html5Qr = null;       // 当前 Html5Qrcode 实例
  var camActive = false;    // 相机是否已启动
  var scanHandled = false;  // 本次启动后是否已处理过扫码结果（防重复触发）
  var camSeq = 0;           // 实例序号：停止/重启时递增，用于丢弃旧实例的迟到回调
  var camSwitching = false; // 是否正在切换摄像头
  var camList = [];         // 系统可用摄像头 [{ id, label }]
  var camIndex = -1;        // 当前使用的摄像头在 camList 中的下标
  var camDeviceId = '';     // 当前摄像头设备 id（浏览器可能不返回，为空时按朝向兜底）
  var camHinted = false;    // 「无可切换摄像头」提示是否已展示过

  var BACK_CAM_RE = /(back|rear|environment|後置|后置|背面)/i;
  var FRONT_CAM_RE = /(front|user|facetime|face|前置|前鏡|前镜|正面)/i;

  /** 相机异常 → 提示文案 */
  function camErrText(err) {
    var msg = (err && (err.message || err.name)) || String(err || '');
    if (/NotAllowedError|Permission|permission/i.test(msg)) return t('p_camDenied');
    if (/NotFoundError|DevicesNotFound|no.*camera|OverconstrainedError/i.test(msg)) return t('p_camNotFound');
    if (/NotReadableError|in use|busy|TrackStartError/i.test(msg)) return t('p_camBusy');
    return t('p_camUnavailable');
  }

  /** 枚举可用摄像头；枚举不可用或无权限时返回空数组（不影响主流程） */
  function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      var arr = [], i;
      for (i = 0; i < list.length; i++) {
        if (list[i].kind === 'videoinput') {
          arr.push({ id: list[i].deviceId, label: list[i].label || ('Camera ' + (arr.length + 1)) });
        }
      }
      return arr;
    }).catch(function () { return []; });
  }

  /** 读取当前预览轨道真实使用的设备 id，用于把 camIndex 定位到实际镜头 */
  function activeTrackDeviceId() {
    try {
      var v = document.querySelector('#camReader video');
      var stream = v && v.srcObject;
      var track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      var st = track && track.getSettings && track.getSettings();
      return (st && st.deviceId) || '';
    } catch (e) { return ''; }
  }

  /** 按标签猜朝向（仅用于优先切到相反镜头，猜不出就按顺序轮换） */
  function labelFacing(label) {
    if (BACK_CAM_RE.test(label || '')) return 'back';
    if (FRONT_CAM_RE.test(label || '')) return 'front';
    return '';
  }

  /** 同步「切换摄像头」按钮状态：仅在相机运行时出现，多摄像头才可点 */
  function updateCamSwitchUI() {
    var btn = $('camSwitchBtn');
    if (!btn) return;
    var multiple = camActive && camList.length >= 2;
    btn.classList.toggle('hidden', !camActive);
    btn.disabled = !multiple;
    var label = (!camActive || multiple) ? t('p_camSwitch') : t('p_camSwitchOnlyOne');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    btn.classList.toggle('busy', camSwitching);
  }

  /** 启动成功后探测摄像头列表，刷新按钮可用性 */
  function syncCameraList() {
    return listCameras().then(function (list) {
      camList = list;
      var id = activeTrackDeviceId();
      if (id) camDeviceId = id;
      camIndex = -1;
      for (var i = 0; i < camList.length; i++) {
        if (camList[i].id === camDeviceId) { camIndex = i; break; }
      }
      if (camIndex < 0 && camList.length === 1) camIndex = 0;
      updateCamSwitchUI();
      // 单摄像头 / 无法枚举：给一次简洁提示，之后不再打扰
      if (camActive && !multipleCameras() && !camHinted) {
        camHinted = true;
        toast(t('p_camSwitchOnlyOne'));
      }
      return camList;
    });
  }

  function multipleCameras() { return camList.length >= 2; }

  /** 彻底失败：复位状态、关闭取景框并提示 */
  function failCamera(err) {
    camSeq++;
    var inst = html5Qr;
    html5Qr = null;
    camActive = false;
    camSwitching = false;
    scanHandled = false;
    if (inst) {
      try { inst.stop(); } catch (e) { /* 忽略 */ }
      try { inst.clear(); } catch (e) { /* 忽略 */ }
    }
    $('camReader').innerHTML = '';
    $('camBox').classList.add('hidden');
    $('camBtn').disabled = false;
    $('camBtn').textContent = t('p_openCam');
    updateCamSwitchUI();
    if (err) $('scanErr').textContent = camErrText(err);
  }

  /** 停止并释放当前实例（切换镜头时复用，不改变按钮文案） */
  function detachScanner() {
    camSeq++;
    var inst = html5Qr;
    html5Qr = null;
    camActive = false;
    scanHandled = false;
    if (!inst) { $('camReader').innerHTML = ''; return Promise.resolve(); }
    var p;
    try { p = inst.stop(); } catch (e) { p = null; }
    return Promise.resolve(p).catch(function () { /* 忽略 */ }).then(function () {
      try { inst.clear(); } catch (e) { /* 忽略 */ }
      $('camReader').innerHTML = '';
    });
  }

  function stopCamera() {
    detachScanner().then(function () {
      $('camBox').classList.add('hidden');
      $('camBtn').textContent = t('p_openCam');
      $('camBtn').disabled = false;
      updateCamSwitchUI();
    });
  }

  /** 解码回调：只接受当前实例（token）的结果，切换期间的旧回调直接丢弃 */
  function onDecoded(token, text) {
    if (token !== camSeq) return;
    if (scanHandled) return;
    scanHandled = true;
    stopCamera();
    handleScannedContent(text);
  }

  /** 启动相机：opts.deviceId 优先（切换镜头用），否则按 facingMode */
  function startScanner(opts) {
    opts = opts || {};
    if (typeof Html5Qrcode === 'undefined') {
      $('scanErr').textContent = t('p_camUnavailable');
      return Promise.reject(new Error('Html5Qrcode not loaded'));
    }
    if (camActive) return Promise.resolve();

    camSeq++;
    var token = camSeq;
    var inst = new Html5Qrcode('camReader');
    html5Qr = inst;
    camActive = true;
    scanHandled = false;
    // 仅记住「本次切换选中的镜头」用于切换流程；重新打开相机时按默认朝向启动
    camDeviceId = opts.deviceId || '';

    $('scanErr').textContent = '';
    $('camBox').classList.remove('hidden');
    $('camBtn').disabled = true;
    $('camBtn').textContent = t('p_camStarting');
    updateCamSwitchUI();

    var target = opts.deviceId
      ? { deviceId: { exact: opts.deviceId } }
      : { facingMode: opts.facingMode || DEFAULT_FACING };

    return inst.start(
      target,
      {
        fps: 10,
        qrbox: function (vw, vh) {
          var s = Math.floor(Math.min(vw, vh) * 0.7);
          return { width: s, height: s };
        },
        aspectRatio: 1
      },
      function (decodedText) { onDecoded(token, decodedText); },
      function (err) {
        // 忽略每帧的常规解码失败（未对准/模糊等），只处理致命错误
      }
    ).then(function () {
      if (token !== camSeq) {           // 启动期间已被停止/替换
        try { inst.stop(); } catch (e) { /* 忽略 */ }
        return;
      }
      return syncCameraList();
    }).catch(function (err) {
      // 本次启动失败：立即释放，交回调用方决定「重试 / 回退 / 提示」
      if (token === camSeq) {
        var cur = html5Qr;
        html5Qr = null;
        camActive = false;
        scanHandled = false;
        camSeq++;
        if (cur) {
          try { cur.stop(); } catch (e) { /* 忽略 */ }
          try { cur.clear(); } catch (e) { /* 忽略 */ }
        }
        $('camReader').innerHTML = '';
        updateCamSwitchUI();
      }
      throw err;
    });
  }

  function startCamera() {
    if (camActive) return;
    // 每次打开都用默认朝向（前置）；用户手动切换只影响本次会话
    startScanner({ facingMode: DEFAULT_FACING }).catch(function (err) {
      // 个别设备不支持 facingMode：退回默认镜头再试一次
      if (/OverconstrainedError|NotFoundError/i.test((err && (err.name || err.message)) || '')) {
        return startScanner({}).catch(function (e2) { failCamera(e2); });
      }
      failCamera(err);
    });
  }

  /**
   * 切换摄像头：先彻底停掉当前实例再以目标 deviceId 重启，
   * 解码回调沿用同一套逻辑，切换期间旧的迟到回调按 token 丢弃。
   * 切换失败时回退到原镜头，保证扫码继续可用。
   */
  function toggleCamera() {
    if (camSwitching || !camActive) return;
    if (!multipleCameras()) { toast(t('p_camSwitchOnlyOne')); return; }

    var fromId = camDeviceId;
    var base = camIndex >= 0 ? camIndex : 0;
    var nextIdx = (base + 1) % camList.length;

    // 标签可辨识时优先切到相反朝向的镜头（前置 ↔ 后置）
    var curFacing = camIndex >= 0 ? labelFacing(camList[camIndex].label) : '';
    if (curFacing) {
      for (var i = 1; i < camList.length; i++) {
        var k = (base + i) % camList.length;
        if (labelFacing(camList[k].label) !== curFacing) { nextIdx = k; break; }
      }
    }
    var next = camList[nextIdx];

    camSwitching = true;
    $('scanErr').textContent = '';
    updateCamSwitchUI();

    detachScanner()
      .then(function () { return startScanner({ deviceId: next.id }); })
      .then(function () {
        camDeviceId = next.id;
        camIndex = nextIdx;
        camSwitching = false;
        updateCamSwitchUI();
      })
      .catch(function (err) {
        // 切换失败：尽力退回原镜头，避免扫码功能中断
        detachScanner().then(function () {
          if (!fromId) { failCamera(err); return; }
          return startScanner({ deviceId: fromId }).catch(function () { failCamera(err); });
        }).then(function () {
          camSwitching = false;
          updateCamSwitchUI();
          $('scanErr').textContent = t('p_camSwitchFail');
        });
      });
  }

  $('camBtn').addEventListener('click', startCamera);
  $('camSwitchBtn').addEventListener('click', toggleCamera);

  /* 手动输入二维码内容 */
  $('manualBtn').addEventListener('click', function () {
    var v = $('manualInput').value.trim();
    $('scanErr').textContent = '';
    if (!v) { $('scanErr').textContent = t('p_manualEmpty'); return; }
    handleScannedContent(v);
  });

  /* ---------- 临时选择上报 ---------- */

  /** 把选择写回界面（服务端回传或本地恢复时用），不触发上报 */
  function applyPickToUI(oe, num) {
    selOE = oe;
    selNum = num == null ? null : Number(num);
    Array.prototype.forEach.call(document.querySelectorAll('.pair .opt'), function (x) {
      x.classList.toggle('sel', x.getAttribute('data-oe') === selOE);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (x) {
      x.classList.toggle('sel', parseInt(x.getAttribute('data-n'), 10) === selNum);
    });
  }

  /** 值真的变了才发：与「服务端已确认的值」比较，而不是与「上次发送的值」比较。
   *  这样 单→双→单 能正确发回单，重复点同一个选项则一个请求都不发。 */
  function flushDraft(force) {
    draftTimer = 0;
    if (!sid || !ut || !pid) return Promise.resolve(null);
    var d = readLocalDraft();
    if (!d) return Promise.resolve(null);
    if (!force && draftConfirmed && draftConfirmed.oe === d.oe && draftConfirmed.num === d.num) {
      return Promise.resolve(null);
    }
    if (draftSending) { draftTimer = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS); return Promise.resolve(null); }

    draftSending = true;
    return fetch('/api/pick', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: pid, sid: sid, ut: ut, oddEven: d.oe, number: d.num, seq: d.seq })
    }).then(function (r) { return r.json(); }).then(function (res) {
      draftSending = false;
      if (!res || !res.ok) {
        // 已提交 / 已锁定：草稿没意义了，清本地，交给 state 渲染
        if (res && (res.code === 'already_submitted' || res.code === 'round_locked')) {
          dropLocalDraft();
          poll();
        }
        return res;
      }
      if (res.accepted) {
        draftConfirmed = { oe: d.oe, num: d.num };
        $('predErr').textContent = '';
      } else if (res.draft) {
        // 服务端更新（乱序/重发被拒）→ 以服务端为准
        draftConfirmed = { oe: res.draft.oe, num: res.draft.num };
        applyPickToUI(res.draft.oe, res.draft.num);
        writeLocalDraft({ oe: res.draft.oe, num: res.draft.num, seq: res.draft.seq, round: d.round });
      }
      return res;
    }).catch(function () {
      draftSending = false;
      // 网络失败：本地草稿留着，重连时 resumeDraft 会补发
      return null;
    });
  }

  /** 玩家改了一次选项：本地立刻记下，停手 DRAFT_DEBOUNCE_MS（250ms）后统一上报（连点只发最后一次）。
   *  必须立刻写本地 —— 这段时间里若来了别人的 state，resumeDraft 会拿本地和服务端比，
   *  本地不更新就会被服务端的旧草稿盖回去（手快的人会看到选项跳回去）。 */
  function scheduleDraft() {
    if (!sid || !pid || !selOE || selNum == null) return;
    writeLocalDraft({
      oe: selOE, num: selNum, seq: nextDraftSeq(), round: state ? state.round : 0
    });
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
  }

  /** 每次拿到全量快照后对齐草稿：
   *  服务端没有 / 比本地旧 → 把本地最后的选择补发一次（断线期间编辑只要求最终一致）；
   *  服务端更新 → 以服务端为准恢复界面。 */
  function resumeDraft(s) {
    if (!s || !s.me) return;
    if (s.me.oddEven != null) { dropLocalDraft(); return; }   // 已提交，草稿作废
    if (s.locked) return;
    var srv = s.me.draft || null;
    var loc = readLocalDraft();
    if (loc && state && loc.round && loc.round !== state.round) { dropLocalDraft(); loc = null; }

    if (srv) draftConfirmed = { oe: srv.oe, num: srv.num };
    else draftConfirmed = null;

    if (loc && (!srv || loc.seq > srv.seq)) {
      applyPickToUI(loc.oe, loc.num);
      flushDraft(true);          // 立即补发，不等 debounce
      return;
    }
    if (srv && (!loc || loc.seq <= srv.seq)) {
      applyPickToUI(srv.oe, srv.num);
    }
  }

  /* ---------- 预测 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.pair .opt'), function (b) {
    b.addEventListener('click', function () {
      var next = b.getAttribute('data-oe');
      if (next === selOE) return;            // 值没变：不重发，也不闪一下
      selOE = next;
      Array.prototype.forEach.call(document.querySelectorAll('.pair .opt'), function (x) {
        x.classList.toggle('sel', x === b);
      });
      $('predErr').textContent = '';
      if (selNum != null) scheduleDraft();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (b) {
    b.addEventListener('click', function () {
      var next = parseInt(b.getAttribute('data-n'), 10);
      if (next === selNum) return;
      selNum = next;
      Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (x) {
        x.classList.toggle('sel', x === b);
      });
      $('predErr').textContent = '';
      if (selOE) scheduleDraft();
    });
  });

  $('predBtn').addEventListener('click', function () {
    if (submitting) return;
    $('predErr').textContent = '';
    if (!selOE) { $('predErr').textContent = t('p_selOddEven'); return; }
    if (selNum == null) { $('predErr').textContent = t('p_selNum'); return; }
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = 0; }
    submitting = true; $('predBtn').disabled = true;
    // 提交体直接带上最终选择：即使草稿请求还在路上/失败了，确认提交也不会丢值
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ensureIdemKey() },
      body: JSON.stringify({ pid: pid, sid: sid, ut: ut, oddEven: selOE, number: selNum })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        dropLocalDraft();
        clearIdemKey();
        toast(t('p_predSubmitting'), 'ok');
        poll();
        return;
      }
      if (handleAuthFail(d)) { $('predBtn').disabled = false; return; }
      // 换设备/超时重试：服务端已有提交 → 按成功处理，直接把状态拉齐
      if (d.code === 'already_submitted') {
        dropLocalDraft();
        clearIdemKey();
        poll();
        return;
      }
      if (d.code === 'round_locked') {
        dropLocalDraft();
        poll();
        $('predErr').textContent = t('p_predClosed');
        $('predBtn').disabled = false;
        return;
      }
      $('predErr').textContent = window.I18N.errCode(d.code, d, 'p_err_') || t('p_predSubmitFail');
      $('predBtn').disabled = false;
    }).catch(function () {
      // 结果未知（网络断了）：保留 idemKey，重试/重连时同 key 重放，不会重复落库
      $('predErr').textContent = t('p_scanNetErr');
      $('predBtn').disabled = false;
    }).finally(function () { submitting = false; });
  });

  /* ---------- 登出（清本机身份 + 通知服务端移出在场名单，保留场次绑定） ----------
   * 只清本机不够：服务端仍会把这个 pid 算进人数/大屏，直到 SSE 重连或超时。
   * 先关掉旧连接（阻止它带着旧 pid 自动重连把标记撤销），再上报离开，最后用空 pid 重连。 */
  $('logoutBtn').addEventListener('click', function () {
    if (!confirm(t('p_logoutConfirm'))) return;
    stopCamera();
    closeRules();             // 登出顺带收起规则层，避免残留遮挡
    rulesShownFor = '';       // 下次登录（重新扫码）再展示一次
    var leavingPid = pid;
    closeStream();
    if (sid && leavingPid) {
      var body = JSON.stringify({ sid: sid, ut: ut, pid: leavingPid, reason: 'logout' });
      try {
        if (!(navigator.sendBeacon && navigator.sendBeacon('/api/leave', body))) {
          fetch('/api/leave', { method: 'POST', body: body, keepalive: true });
        }
      } catch (err) { /* 上报失败也不阻塞登出：SSE 断开后不会再用旧 pid 重连 */ }
    }
    pid = '';
    localStorage.removeItem(pidKey(sid));
    selOE = null; selNum = null;
    clearPredSelection();
    state = null;
    $('logoutBtn').classList.add('hidden');
    toast(t('p_loggedOut'), 'ok');
    startStream(); // 清除 pid 后重连
    poll();
  });

  /* ---------- 切换场次：展开选择，但要真正切过去必须重新验证口令 ---------- */
  $('switchSessBtn').addEventListener('click', function () {
    stopCamera();
    picking = true;       // 不关闭当前场次连接：取消选择可原样退回
    render();
    loadSessions();
  });

  /* ---------- 口令弹层事件 ---------- */
  $('pwBtn').addEventListener('click', submitPw);
  $('pwCancel').addEventListener('click', function () {
    closePwModal();
    picking = false;   // 取消即退出选择态：有绑定则原样回到当前场次，无绑定则留在选择界面
    render();
  });
  $('pwInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitPw(); }
    if (e.key === 'Escape') { e.preventDefault(); $('pwCancel').click(); }
  });
  $('pwMask').addEventListener('click', function (e) {
    if (e.target === $('pwMask')) $('pwCancel').click();
  });
  $('sessCancel').addEventListener('click', function () {
    picking = false;
    render();
  });

  /* ---------- 语言切换 ---------- */
  $('langBtn').addEventListener('click', function () {
    var next = window.I18N.nextLocale();
    if (window.I18N.setLocale(next)) applyI18n();
  });

  /* ---------- 离开上报：把玩家移出实时名单/统计，不动本轮已提交的预测 ----------
     用 sendBeacon 保证页面关闭时也能发出；刷新/回前台时 SSE 重连会自动撤销该标记
     （本轮未锁定时才撤销，锁定后名单冻结）。 */
  window.addEventListener('pagehide', function (e) {
    if (e.persisted) return;              // 进 bfcache 不算离开（返回时页面原样恢复）
    if (!sid || !pid) return;
    var body = JSON.stringify({ sid: sid, ut: ut, pid: pid, reason: 'leave' });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/leave', body)) return;
    } catch (err) { /* 走下面的兜底 */ }
    try {
      fetch('/api/leave', { method: 'POST', body: body, keepalive: true });
    } catch (err) { /* 忽略 */ }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      // 回到前台：重连 SSE 并立即对齐一次
      if (sid) { startStream(); poll(); }
      resumeRules();
    } else {
      stopCamera();
      closeStream(); // 后台关闭连接，省资源；回前台时重连
      pauseRules();
    }
  });

  /* 初始化：应用语言 → 决定进入哪个场次 → 建立该场次的 SSE 连接 */
  applyI18n();
  bootstrap();
})();
