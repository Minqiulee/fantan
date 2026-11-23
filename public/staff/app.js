/* staff 页面逻辑 —— 自原 staff.html 内联 <script> 原样抽出 */
(function () {
  'use strict';
  var TOKEN_KEY = 'oe_staff_token';
  var token = sessionStorage.getItem(TOKEN_KEY) || '';
  var sid = '';                 // 当前归属的场次（服务端 token 绑定为准，这里保存一份用于渲染）
  var sessions = [];            // 场次列表（员工视角，含已关闭）
  var state = null, selNum = null, confirming = false;
  var picking = false;          // 是否展开「选择场次」（与玩家端同一套交互）
  var loggedIn = false;         // 是否已通过员工登录（控制顶栏入口显隐）
  var me = { username: '', role: 'staff', displayName: '' }; // 当前登录账号（决定管理入口可见）
  var pwdTargetSid = '';        // 待切换的目标场次（口令弹层的上下文）
  window.I18N.init({ storageKey: 'oe_staff_locale' });
  var t = window.I18N.t;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 语言切换 ---------- */
  var LANG_LABEL = { 'zh-HK': '繁體', 'zh-CN': '简体', 'en-US': 'EN' };

  /** 刷新语言按钮上的短标签（单个地球按钮，显示当前语言码）。 */
  function updateLangButton() {
    var code = $('langCode');
    var lang = window.I18N.getLocale();
    if (code) code.textContent = LANG_LABEL[lang] || lang;
  }

  $('langBtn').addEventListener('click', function () {
    var next = window.I18N.nextLocale();
    if (window.I18N.setLocale(next)) {
      applyStaticI18n();
      renderSessionBar();
      renderSessionPick();
      render();
    }
  });

  /** 应用静态文本（data-i18n / data-i18n-placeholder），并刷新语言按钮标签 */
  function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.title = t('brand') + ' · ' + t('staffTag');
    updateLangButton();
  }

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 2600);
  }

  /* ---------- 自定义确认弹窗 ---------- */
  var modalResolve = null;
  var ICON = {
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    plain: '<svg viewBox="0 0 24 24" fill="none" stroke="#4f8cff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'
  };

  /** 弹出自定义确认框。opts: { type:'warn'|'plain', title, body(HTML), okText, cancelText }。
   *  返回 Promise<boolean>，用户点确认 resolve(true)，取消/关闭 resolve(false)。 */
  function confirmModal(opts) {
    if (modalResolve) modalResolve(false); // 已有弹窗未决时先关闭旧的
    var box = $('modalBox');
    box.className = 'modal ' + (opts.type === 'warn' ? 'warn' : 'plain');
    $('modalIco').innerHTML = opts.type === 'warn' ? ICON.warn : ICON.plain;
    $('modalTitle').textContent = opts.title;
    $('modalBody').innerHTML = opts.body;
    $('modalOk').textContent = opts.okText;
    $('modalCancel').textContent = opts.cancelText;
    $('modalMask').classList.add('show');
    return new Promise(function (resolve) {
      modalResolve = function (v) { resolve(v); };
    });
  }

  function closeModal(v) {
    $('modalMask').classList.remove('show');
    if (modalResolve) { var r = modalResolve; modalResolve = null; r(v); }
  }

  $('modalOk').addEventListener('click', function () { closeModal(true); });
  $('modalCancel').addEventListener('click', function () { closeModal(false); });
  $('modalMask').addEventListener('click', function (e) { if (e.target === $('modalMask')) closeModal(false); });

  function setAuth(tk) {
    token = tk;
    if (tk) sessionStorage.setItem(TOKEN_KEY, tk);
    else sessionStorage.removeItem(TOKEN_KEY);
    // 管理界面会把同一份 token 存到 localStorage 以便独立打开；退出登录时一并清掉，避免残留登录态
    if (!tk) { try { localStorage.removeItem('oe_admin_token'); } catch (e) { /* 忽略 */ } }
  }

  function showLogin() {
    loggedIn = false;
    picking = false;
    $('loginCard').classList.remove('hidden');
    $('mainContent').classList.add('hidden');
    renderLayout();
  }

  function showMain() {
    loggedIn = true;
    $('loginCard').classList.add('hidden');
    $('mainContent').classList.remove('hidden');
    renderLayout();
  }

  function esc(x) {
    return String(x).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  /* ---------- 场次：渲染 ---------- */
  function currentSession() {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === sid) return sessions[i];
    return null;
  }

  /** 切换列表只列进行中的场次（与玩家端一致，已关闭的不能切进去） */
  function openSessions() {
    return sessions.filter(function (s) { return s.status === 'open'; });
  }

  /** 场次条：只展示当前场次名称与状态，入口统一在顶栏 */
  function renderSessionBar() {
    var cur = currentSession();
    $('sbName').textContent = cur ? cur.name : '—';
    var badge = $('sbBadge');
    if (cur) {
      badge.classList.remove('hidden');
      badge.textContent = t(cur.status === 'open' ? 'sessionStatusOpen' : 'sessionStatusClosed');
      badge.className = 'sb-badge' + (cur.status === 'open' ? '' : ' closed');
    } else {
      badge.classList.add('hidden');
    }
    renderLayout();
  }

  /** 顶栏账号徽标：显示显示名（管理员额外标角色），鼠标悬停看账号 */
  function renderUserChip() {
    var el = $('userChip');
    if (!me.username) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    var label = me.displayName || me.username;
    el.innerHTML = esc(label) + (me.role === 'admin' ? ' · <b>' + esc(t('roleAdmin')) + '</b>' : '');
    el.title = me.username + (me.role === 'admin' ? ' (' + t('roleAdmin') + ')' : '');
  }

  /** 顶栏 / 卡片显隐：展开选择时只留选择卡（与玩家端 picking 表现一致） */
  function renderLayout() {
    var cur = currentSession();
    renderUserChip();
    // 「管理」只给管理员：员工有自己的一套场次操作，不该看到对账与账号管理
    $('adminBtn').classList.toggle('hidden', !loggedIn || me.role !== 'admin');
    $('userChip').classList.toggle('hidden', !loggedIn || !me.username);
    $('switchSessBtn').classList.toggle('hidden', !loggedIn || picking || !openSessions().length);
    $('cardSession').classList.toggle('hidden', !loggedIn || !picking);
    $('sessCancel').classList.toggle('hidden', !loggedIn || !picking || !cur);
    $('sessionBar').classList.toggle('hidden', !loggedIn || picking);
    $('sessionBody').classList.toggle('hidden', !loggedIn || picking || !cur);
    $('noSessionCard').classList.toggle('hidden', !loggedIn || picking || !!cur);
  }

  /** 选择场次卡里的选项列表（整行可点，当前场次打勾） */
  function renderSessionPick() {
    var box = $('sessPick');
    var list = openSessions();
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + esc(t('sessionNoOpen')) + '</div>';
      return;
    }
    box.innerHTML = list.map(function (s) {
      var meta = t('roundInfo', { round: s.round }) + ' · ' +
        (s.locked ? t('roundLocked') : t('roundOngoing')) + ' · ' +
        t('sessionPlayersCount', { n: s.players });
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

  /** 员工视角刷新场次列表（含已关闭；切换列表只取进行中） */
  function refreshSessions() {
    if (!token) return Promise.resolve();
    return fetch('/api/sessions?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.sessions) {
          sessions = d.sessions;
          renderSessionBar();
          renderSessionPick();
        }
      })
      .catch(function () {});
  }

  /* ---------- 场次：交互 ---------- */
  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /** 点选场次：已在本场则直接收起；否则切换（员工需先过「切换场次」口令） */
  function chooseSession(id) {
    if (!id) return;
    if (id === sid) { picking = false; renderLayout(); return; }
    if (me.role === 'admin') { doSelectSession(id, null); return; } // 管理员免口令（服务端同口径）
    openSwitchPwd(id);
  }

  /** 切换场次：只改自己的绑定，重建 SSE 连接并拉取该场次状态 */
  function doSelectSession(id, sessionPassword) {
    var body = { token: token, sid: id };
    if (sessionPassword != null) body.sessionPassword = sessionPassword;
    postJson('/api/session-select', body).then(function (d) {
      if (d.ok) {
        closeSwitchPwd();
        picking = false;
        applySessionSwitch(d.sid, d.sessions);
        var cur = currentSession();
        toast(t('toastSessionSwitched', { name: cur ? cur.name : '' }), 'ok');
      } else if (d.code === 'unauthorized') { forceLogout(); }
      else if (d.code === 'staff_session_password_required' || d.code === 'staff_wrong_password' ||
               d.code === 'staff_too_many_attempts') {
        // 口令缺失 / 错误 / 限频：留在口令弹层里提示，不要静默失败
        openSwitchPwd(id);
        $('switchPwdErr').textContent = window.I18N.errCode(d.code, d) || t('errLoginFailed');
      } else { toast(window.I18N.errCode(d.code, d) || t('errOpFailed'), 'err'); }
    }).catch(function () { toast(t('errNetRetry'), 'err'); });
  }

  /* ---------- 切换场次口令弹层 ---------- */
  function openSwitchPwd(id) {
    pwdTargetSid = id;
    $('switchPwdInput').value = '';
    $('switchPwdErr').textContent = '';
    $('switchPwdMask').classList.add('show');
    setTimeout(function () { try { $('switchPwdInput').focus(); } catch (e) { /* 忽略 */ } }, 120);
  }

  function closeSwitchPwd() {
    $('switchPwdMask').classList.remove('show');
    $('switchPwdInput').value = '';
    $('switchPwdErr').textContent = '';
    pwdTargetSid = '';
  }

  function submitSwitchPwd() {
    if (!pwdTargetSid) { closeSwitchPwd(); return; }
    var pw = $('switchPwdInput').value;
    if (!pw) { $('switchPwdErr').textContent = t('errEmptyPwd'); return; }
    doSelectSession(pwdTargetSid, pw);
  }

  $('switchPwdOk').addEventListener('click', submitSwitchPwd);
  $('switchPwdCancel').addEventListener('click', closeSwitchPwd);
  $('switchPwdMask').addEventListener('click', function (e) {
    if (e.target === $('switchPwdMask')) closeSwitchPwd();
  });
  $('switchPwdInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitSwitchPwd(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSwitchPwd(); }
  });

  /** 场次切换后的本地复位：清空选择、重建连接、重新拉状态 */
  function applySessionSwitch(nextSid, list) {
    sid = nextSid || '';
    if (list) sessions = list;
    state = null;
    lastVersion = -1;       // 换场次后版本号重新起算，不能拿上一场的版本比大小
    resetNumberSelection();
    renderSessionBar();
    renderSessionPick();
    if (sid) { startStream(); poll(); }
    else { closeStream(); render(); }
  }

  function resetNumberSelection() {
    selNum = null;
    $('selShow').textContent = '—';
    $('confirmBtn').disabled = true;
    $('inputErr').textContent = '';
    Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (x) { x.classList.remove('sel'); });
  }

  /** 打开选择场次（不发请求前提：刷新列表后会重绘） */
  function openPicker() {
    picking = true;
    renderSessionPick();
    renderLayout();
    refreshSessions();
  }

  function closePicker() {
    picking = false;
    renderLayout();
  }

  /** 管理界面：当日对账 / 大屏 / 新建场次 / 关闭场次 都在 /admin */
  function goAdmin() {
    if (!token) { showLogin(); return; }
    location.href = '/admin';
  }

  $('switchSessBtn').addEventListener('click', openPicker);
  $('sessCancel').addEventListener('click', closePicker);
  $('adminBtn').addEventListener('click', goAdmin);
  $('btnGoAdmin').addEventListener('click', goAdmin);

  /* ---------- 渲染 ---------- */
  function render() {
    var s = state;
    if (!s) { $('roundInfo').textContent = '—'; return; }

    $('roundInfo').textContent = s.session.name + ' · ' + t('roundInfo', { round: s.round }) +
      (s.locked ? ' · ' + t('roundLocked') : ' · ' + t('roundOngoing'));

    var locked = s.locked;
    $('statusPill').className = 'status-pill ' + (locked ? 'st-locked' : 'st-input');
    $('statusText').textContent = t(locked ? 'statusLocked' : 'statusInput');

    $('cardInput').classList.toggle('hidden', locked);
    $('cardLocked').classList.toggle('hidden', !locked);

    // 人数以服务端 counts 为准：只算在场玩家，与大屏同一份快照、同一口径。
    var reg = (s.counts && s.counts.total != null) ? s.counts.total : s.players.length;
    var pred = (s.counts && s.counts.submitted != null)
      ? s.counts.submitted
      : s.players.filter(function (p) { return p.submitted; }).length;
    $('cntReg').textContent = reg;
    $('cntPred').textContent = pred;

    renderPlayerList(s);

    if (locked) {
      $('lockedNum').textContent = s.number;
      var n = s.number;
      // 额外奖励：本轮是否命中特殊数字（来自服务端快照，与是否有玩家无关，照常提示）
      $('bonusBanner').classList.toggle('hidden', !(s.bonus && s.bonus.triggered));
      if (!s.players.length) {
        $('resultTableWrap').innerHTML = '<div class="empty">' + t('noPlayerReg') + '</div>';
        return;
      }
      var rows = s.players.map(function (p) {
        // 单双命中：基于开奖数字奇偶性判定，与语言无关（「单/單」「双/雙」字形差异不再影响结果）
        var pOE = (p.oddEven === '单') === (n % 2 === 1), pN = p.number === n;
        var pOEText = p.oddEven === '单' ? t('odd') : (p.oddEven === '双' ? t('even') : (p.oddEven || '—'));
        return '<tr><td>' + esc(p.maskedId || p.id) + '</td>' +
          '<td>' + esc(pOEText) + '</td>' +
          '<td>' + esc(p.number != null ? p.number : '—') + '</td>' +
          '<td class="' + (pOE ? 'hit-txt' : 'miss-txt') + '">' + (pOE ? t('hit') : t('miss')) + '</td>' +
          '<td class="' + (pN ? 'hit-txt' : 'miss-txt') + '">' + (pN ? t('hit') : t('miss')) + '</td></tr>';
      }).join('');
      $('resultTableWrap').innerHTML =
        '<table><tr><th>' + t('thPlayer') + '</th><th>' + t('thOddEven') + '</th><th>' + t('thNumber') +
        '</th><th>' + t('thOddEvenResult') + '</th><th>' + t('thNumberResult') + '</th></tr>' + rows + '</table>';
    }
  }

  /* ---------- 本轮玩家列表（新老区分） ---------- */
  function renderPlayerList(s) {
    var list = $('playerList');
    var total = (s.counts && s.counts.total != null) ? s.counts.total : s.players.length;
    var vetCount = s.players.filter(function (p) { return p.isVeteran; }).length;
    var newCount = total - vetCount;
    $('plistCount').textContent = t('plistCount', { total: total, new: newCount, vet: vetCount });

    if (!s.players.length) {
      list.innerHTML = '<div class="empty">' + t('noPlayerYet') + '</div>';
      return;
    }
    list.innerHTML = s.players.map(function (p) {
      var cls = p.isVeteran ? 'is-vet' : 'is-new';
      var tag = p.isVeteran ? t('tagVet') : t('tagNew');
      return '<div class="p ' + cls + '">' +
        '<span class="nm">' + esc(p.maskedId || p.id) + '</span>' +
        '<span class="tag-n">' + tag + '</span>' +
        '</div>';
    }).join('');
  }

  /* 当日对账 / 大屏 / 新建场次 / 关闭场次 已移到管理界面（/admin） */

  /* ---------- 网络（SSE 实时推送 + 断线重连） ---------- */
  var es = null;           // EventSource 实例
  var streamClosed = false; // 手动关闭标记
  var lastVersion = -1;    // 已应用的最新场次版本号（旧帧直接丢弃，避免轮询响应盖回新状态）

  function applyState(s) {
    if (!s || !s.ok) return;
    // 断线补拉与 SSE 推送会并发到达：版本更小的帧一律丢弃。否则「离开」先到、
    // 更早发出的轮询响应后到，会把已经移除的玩家又画回列表里（大屏同样按版本丢弃）。
    if (s.version != null) {
      if (lastVersion >= 0 && s.version < lastVersion) return;
      if (s.version > lastVersion) lastVersion = s.version;
    }
    $('connLost').classList.add('hidden');
    var wasLocked = state ? state.locked : false;
    state = s;
    if (s.session) {
      // 场次名称可能被别的员工端改过（当前无改名功能，此处仅保持同步）
      sid = s.session.id;
    }
    render();
    if (!wasLocked && s.locked) toast(t('toastNumberLocked', { number: s.number }), 'ok');
  }

  /** 关闭当前 SSE 连接。 */
  function closeStream() {
    streamClosed = true;
    if (es) { es.close(); es = null; }
  }

  /** 建立 SSE 连接：绑定当前场次，只收本场次的事件。
   *  带员工 token：员工视角不受玩家场次口令约束。 */
  function startStream() {
    closeStream();
    if (!sid) return;
    streamClosed = false;
    es = new EventSource('/api/stream?sid=' + encodeURIComponent(sid) +
      (token ? '&token=' + encodeURIComponent(token) : ''));

    es.onopen = function () {
      $('connLost').classList.add('hidden');
      poll(); // 重连成功后全量对齐一次
    };

    es.addEventListener('state', function (ev) {
      try { applyState(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    });

    // 场次被关闭（可能是别的员工端关的）
    es.addEventListener('session_closed', function (ev) {
      var d = {};
      try { d = JSON.parse(ev.data) || {}; } catch (e) { /* 忽略坏帧 */ }
      if (d.sid && d.sid !== sid) return;
      closeStream();
      toast(t('toastSessionClosed', { name: (currentSession() || {}).name || '' }), 'err');
      refreshSessions().then(function () {
        var next = '';
        for (var i = 0; i < sessions.length; i++) { if (sessions[i].status === 'open') { next = sessions[i].id; break; } }
        applySessionSwitch(next, sessions);
      });
    });

    es.onerror = function () {
      if (streamClosed) return;
      if (es && es.readyState === EventSource.CONNECTING) {
        $('connLost').classList.remove('hidden');
      }
    };
  }

  /** 拉取一次当前场次的全量状态快照，用于对齐 SSE 断线/回到前台期间错过的变更。 */
  function poll() {
    if (!sid) return;
    fetch('/api/state?sid=' + encodeURIComponent(sid) + (token ? '&token=' + encodeURIComponent(token) : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.ok) applyState(s);
        else if (s && s.code === 'session_not_found') {
          // 场次已不存在：回退到列表里的第一个进行中场次
          refreshSessions();
        }
      })
      .catch(function () {
        $('connLost').classList.remove('hidden');
      });
  }

  /* ---------- 交互 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (b) {
    b.addEventListener('click', function () {
      if (state && state.locked) return;
      selNum = parseInt(b.getAttribute('data-n'), 10);
      Array.prototype.forEach.call(document.querySelectorAll('#numGrid button'), function (x) {
        x.classList.toggle('sel', x === b);
      });
      $('selShow').textContent = selNum;
      $('confirmBtn').disabled = false;
      $('inputErr').textContent = '';
    });
  });

  $('confirmBtn').addEventListener('click', async function () {
    if (confirming || !state || state.locked) return;
    if (selNum == null || !Number.isInteger(selNum) || selNum < 0 || selNum > 9) {
      $('inputErr').textContent = t('errPickNumber');
      return;
    }
    // 开奖前检查：分两类提示，语义完全不同
    //   未提交 = 没按确认提交（含「选了没确认」），锁定即作废，不算参赛
    //   待确认 = 已点选但没按确认提交，人数最多的一类争议来源，必须让员工看见
    var unpredicted = state.players.filter(function (p) { return !p.submitted; }).length;
    // 兼容两种投影：玩家视图带 draft 布尔，大屏视图只有 status（将来员工端切视图也不会漏算）
    var drafting = state.players.filter(function (p) {
      return p.draft === true || p.status === 'draft';
    }).length;
    var ack = false;
    if (unpredicted > 0) {
      var proceed = await confirmModal({
        type: 'warn',
        title: t('modalUnpredictedTitle'),
        body: t('modalUnpredictedBody', { count: unpredicted })
          + (drafting > 0 ? '<br><b>' + t('modalDraftNote', { count: drafting }) + '</b>' : ''),
        okText: t('modalUnpredictedOk'),
        cancelText: t('modalCancelText')
      });
      if (!proceed) return;
      ack = true;
    }
    var sure = await confirmModal({
      type: 'plain',
      title: t('modalConfirmTitle'),
      body: t('modalConfirmBody', { number: selNum }),
      okText: t('modalConfirmOk'),
      cancelText: t('modalCancelText')
    });
    if (!sure) return;

    confirming = true; $('confirmBtn').disabled = true;
    try {
      // 最多两轮：服务端若报「还有草稿未确认」（其他实例刚收到新草稿），再确认一次即带上 ackPending
      for (var attempt = 0; attempt < 2; attempt += 1) {
        var d = await postJson('/api/confirm', {
          number: selNum, token: token, sid: sid, ackPending: ack
        });
        if (d && d.ok) {
          if (d.archived === false) toast(t('toastArchiveFailed'), 'err');
          else toast(t('toastLocked', { number: d.number }), 'ok');
          poll();
          break;
        }
        if (d && d.code === 'pending_confirm_required' && !ack) {
          var n = (d.pending || []).length;
          var go = await confirmModal({
            type: 'warn',
            title: t('modalUnpredictedTitle'),
            body: t('modalDraftNote', { count: n }),
            okText: t('modalUnpredictedOk'),
            cancelText: t('modalCancelText')
          });
          if (!go) { $('confirmBtn').disabled = false; break; }
          ack = true;
          continue;
        }
        if (d && d.code === 'unauthorized') { forceLogout(); break; }
        $('inputErr').textContent = window.I18N.errCode(d && d.code, d) || t('errConfirmFailed');
        $('confirmBtn').disabled = false;
        poll();
        break;
      }
    } catch (e) {
      $('inputErr').textContent = t('errNetRetry');
      $('confirmBtn').disabled = false;
    } finally {
      confirming = false;
    }
  });

  $('resetBtn').addEventListener('click', async function () {
    if (!state || !state.locked) return;
    var sure = await confirmModal({
      type: 'plain',
      title: t('modalResetTitle'),
      body: t('modalResetBody'),
      okText: t('modalResetOk'),
      cancelText: t('modalCancelText')
    });
    if (!sure) return;
    postJson('/api/reset', { token: token, sid: sid }).then(function (d) {
      if (d.ok) {
        resetNumberSelection();
        toast(t('toastNewRound', { round: d.round }), 'ok');
        poll();
      } else if (d.code === 'unauthorized') { forceLogout(); }
      else { toast(window.I18N.errCode(d.code, d) || t('errOpFailed'), 'err'); }
    }).catch(function () { toast(t('errNetRetry'), 'err'); });
  });

  /* ---------- 登录 / 退出 ---------- */
  function forceLogout() {
    closeStream();
    closeSwitchPwd();
    setAuth('');
    me = { username: '', role: 'staff', displayName: '' };
    sessions = []; sid = ''; state = null;
    showLogin();
    toast(t('errSessionExpired'), 'err');
  }

  $('loginBtn').addEventListener('click', function () {
    var user = $('userInput').value.trim();
    var pw = $('pwdInput').value;
    $('loginErr').textContent = '';
    if (!user) { $('loginErr').textContent = t('errEmptyUser'); return; }
    if (!pw) { $('loginErr').textContent = t('errEmptyPwd'); return; }
    $('loginBtn').disabled = true;
    postJson('/api/staff-login', { username: user, password: pw }).then(function (d) {
      if (d.ok) {
        setAuth(d.token);
        me = d.user || { username: user, role: 'staff', displayName: '' };
        $('pwdInput').value = '';
        sessions = d.sessions || [];
        showMain();
        applySessionSwitch(d.sid || '', sessions);
      } else { $('loginErr').textContent = window.I18N.errCode(d.code, d) || t('errLoginFailed'); }
    }).catch(function () { $('loginErr').textContent = t('errNetRetry'); })
      .finally(function () { $('loginBtn').disabled = false; });
  });

  ['pwdInput', 'userInput'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('loginBtn').click();
    });
  });

  $('logoutBtn').addEventListener('click', function () {
    closeStream();
    postJson('/api/staff-logout', { token: token });
    setAuth('');
    me = { username: '', role: 'staff', displayName: '' };
    sessions = []; sid = ''; state = null;
    showLogin();
  });

  /* 启动时校验会话有效性，并取回绑定的场次与账号 */
  fetch('/api/staff-check?token=' + encodeURIComponent(token)).then(function (r) { return r.json(); }).then(function (d) {
    if (d.ok) {
      me = d.user || me;
      sessions = d.sessions || [];
      showMain();
      applySessionSwitch(d.sid || '', sessions);
    } else showLogin();
  }).catch(function () { showLogin(); });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { startStream(); poll(); }
    else closeStream();
  });

  /* 初始化语言：应用静态文本 */
  updateLangButton();
  applyStaticI18n();
  renderSessionBar();
})();
