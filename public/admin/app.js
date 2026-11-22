/* admin 页面逻辑 —— 自原 admin.html 内联 <script> 原样抽出 */
(function () {
  'use strict';
  /* 管理界面：当日对账 / 大屏 / 新建场次 / 关闭场次。
   * 与员工端共用同一个员工 token 与场次绑定：
   *   - 从员工端点「管理」跳进来（同标签页）→ sessionStorage 里的 token 直接可用
   *   - 独立打开（新标签 / 收藏夹）→ 支持 ?token= 预置，页面立刻从地址栏抹掉并只存本地
   * 这里不做实时推送：进页面、切回前台、每次操作后各刷新一次场次列表即可。 */
  var TOKEN_KEY = 'oe_admin_token';
  var STAFF_TOKEN_KEY = 'oe_staff_token';
  var MAX_OPEN_SESSIONS = 4;

  var token = '';
  var sid = '';
  var sessions = [];
  var me = { username: '', role: '', displayName: '' };   // 当前登录的管理员账号

  window.I18N.init({ storageKey: 'oe_staff_locale' });   // 与员工端共用语言偏好
  var t = window.I18N.t;
  var $ = function (id) { return document.getElementById(id); };

  var LANG_LABEL = { 'zh-HK': '繁體', 'zh-CN': '简体', 'en-US': 'EN' };

  function updateLangButton() {
    var code = $('langCode');
    var lang = window.I18N.getLocale();
    if (code) code.textContent = LANG_LABEL[lang] || lang;
  }

  function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.title = t('brand') + ' · ' + t('adminTag');
    updateLangButton();
  }

  $('langBtn').addEventListener('click', function () {
    var next = window.I18N.nextLocale();
    if (window.I18N.setLocale(next)) { applyStaticI18n(); render(); }
  });

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 2600);
  }

  function esc(x) {
    return String(x).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /* ---------- 弹窗 ---------- */
  var modalResolve = null;
  var ICON = {
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    plain: '<svg viewBox="0 0 24 24" fill="none" stroke="#4f8cff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'
  };

  /** 返回 Promise：确认 → true（带输入框时返回输入内容，空串也算确认）；取消 → false */
  function confirmModal(opts) {
    if (modalResolve) modalResolve(false);
    var box = $('modalBox');
    box.className = 'modal ' + (opts.type === 'warn' ? 'warn' : 'plain');
    $('modalIco').innerHTML = opts.type === 'warn' ? ICON.warn : ICON.plain;
    $('modalTitle').textContent = opts.title;
    $('modalBody').innerHTML = opts.body || '';
    $('modalOk').textContent = opts.okText;
    $('modalCancel').textContent = opts.cancelText;
    var inp = $('modalInput');
    inp.classList.toggle('hidden', !opts.input);
    if (opts.input) {
      inp.value = '';
      inp.type = opts.password ? 'password' : 'text';   // 重置密码时不回显明文
      inp.setAttribute('placeholder', opts.placeholder || '');
    }
    $('modalMask').classList.add('show');
    if (opts.input) setTimeout(function () { try { inp.focus(); } catch (e) { /* 忽略 */ } }, 120);
    return new Promise(function (resolve) { modalResolve = resolve; });
  }

  function closeModal(v) {
    $('modalMask').classList.remove('show');
    var inp = $('modalInput');
    var withInput = !inp.classList.contains('hidden');   // 带输入框的弹窗（新建场次）
    var value = withInput ? inp.value.trim() : '';
    if (modalResolve) {
      var r = modalResolve;
      modalResolve = null;
      if (!v) { r(false); return; }                      // 取消 → false
      r(withInput ? value : true);                       // 输入框弹窗 → 输入内容（可为空串 = 自动命名）
    }
  }

  $('modalOk').addEventListener('click', function () { closeModal(true); });
  $('modalCancel').addEventListener('click', function () { closeModal(false); });
  $('modalMask').addEventListener('click', function (e) { if (e.target === $('modalMask')) closeModal(false); });
  $('modalInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); closeModal(true); }
    if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
  });

  /* ---------- 登录态 ---------- */
  function saveToken(tk) {
    token = tk || '';
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式忽略 */ }
    try {
      // 与员工端共用登录：跳回去不用重新输密码
      if (token) sessionStorage.setItem(STAFF_TOKEN_KEY, token);
      else sessionStorage.removeItem(STAFF_TOKEN_KEY);
    } catch (e) { /* 忽略 */ }
  }

  function showLogin(keepToken) {
    if (!keepToken) saveToken('');
    me = { username: '', role: '', displayName: '' };
    $('loginCard').classList.remove('hidden');
    $('mainContent').classList.add('hidden');
    $('logoutBtn').classList.add('hidden');
    $('toStaffBtn').classList.add('hidden');
    $('userChip').classList.add('hidden');
    $('adminRound').textContent = '—';
    setTimeout(function () { try { $('userInput').focus(); } catch (e) { /* 忽略 */ } }, 120);
  }

  function showMain() {
    $('loginCard').classList.add('hidden');
    $('mainContent').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    $('toStaffBtn').classList.remove('hidden');
    $('userChip').classList.remove('hidden');
    renderUserChip();
  }

  /** 顶栏账号徽标：显示名（管理员）——账号本身放 title，避免顶栏过长 */
  function renderUserChip() {
    var el = $('userChip');
    if (!me.username) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = esc(me.displayName || me.username) + ' · <b>' + esc(t('roleAdmin')) + '</b>';
    el.title = me.username;
  }

  /** 只有管理员能进这个页面：员工账号进来一律退回登录页 */
  function applyAuth(d) {
    me = d.user || me;
    if (me.role !== 'admin') {
      showLogin();
      $('loginErr').textContent = t('errAdminOnly');
      return false;
    }
    sid = d.sid || '';
    sessions = d.sessions || [];
    showMain();
    render();
    return true;
  }

  function checkAuth() {
    if (!token) { showLogin(); return; }
    fetch('/api/staff-check?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { showLogin(); return; }
        applyAuth(d);
      })
      .catch(function () { showLogin(); });
  }

  function forceLogout() {
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
      if (d && d.ok) {
        saveToken(d.token);
        $('pwdInput').value = '';
        applyAuth(d);
      } else {
        $('loginErr').textContent = window.I18N.errCode(d && d.code, d) || t('errLoginFailed');
      }
    }).catch(function () { $('loginErr').textContent = t('errNetRetry'); })
      .finally(function () { $('loginBtn').disabled = false; });
  });

  ['pwdInput', 'userInput'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('loginBtn').click();
    });
  });

  $('logoutBtn').addEventListener('click', function () {
    postJson('/api/staff-logout', { token: token });
    sessions = []; sid = '';
    showLogin();
  });

  $('toStaffBtn').addEventListener('click', function () { location.href = '/staff'; });

  /* ---------- 场次列表 ---------- */
  function currentSession() {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === sid) return sessions[i];
    return null;
  }

  function openSessions() {
    return sessions.filter(function (s) { return s.status === 'open'; });
  }

  function refreshSessions() {
    if (!token) return Promise.resolve();
    return fetch('/api/sessions?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.sessions) { sessions = d.sessions; render(); }
      })
      .catch(function () {});
  }

  /** 渲染当前场次 + 各入口的可用性 */
  function render() {
    var cur = currentSession();
    var badge = $('sbBadge');

    $('sbName').textContent = cur ? cur.name : '—';
    if (cur) {
      badge.classList.remove('hidden');
      badge.textContent = t(cur.status === 'open' ? 'sessionStatusOpen' : 'sessionStatusClosed');
      badge.className = 'sb-badge' + (cur.status === 'open' ? '' : ' closed');
    } else {
      badge.classList.add('hidden');
    }

    $('sbMeta').textContent = cur
      ? t('roundInfo', { round: cur.round }) + ' · ' +
        (cur.locked ? t('roundLocked') : t('roundOngoing')) + ' · ' +
        t('sessionPlayersCount', { n: cur.players })
      : t('adminNeedSession');

    $('adminRound').textContent = cur
      ? cur.name + ' · ' + t('roundInfo', { round: cur.round })
      : t('adminNeedSession');

    var openCur = !!cur && cur.status === 'open';
    $('entryBoard').disabled = !openCur;                                    // 大屏跟着当前场次
    $('entryClose').disabled = !openCur;                                    // 只能关当前场次
    $('entryCreate').disabled = openSessions().length >= MAX_OPEN_SESSIONS;  // 场次上限
  }

  /* ---------- 各入口 ---------- */

  /* ① 当日对账：归档口径只读聚合 + CSV 导出，与当前场次无关 */
  var archiveDate = '';
  var archiveLoaded = false;

  /** 四个二级视图共用一个切换函数：把入口区与各视图的显隐收在一处，避免互相打架 */
  var VIEWS = { archive: 'archiveView', account: 'accountView', audit: 'auditView', prize: 'prizeView' };

  function showView(name) {
    var on = !!VIEWS[name];
    $('entries').classList.toggle('hidden', on);
    Object.keys(VIEWS).forEach(function (k) {
      $(VIEWS[k]).classList.toggle('hidden', k !== name);
    });
    // 奖品设置要并排放三语三列，640 的窄栏放不下：宽屏上只在奖品页放宽容器（见 style.css）
    document.body.setAttribute('data-view', on ? name : '');
    if (name === 'archive') { archiveLoaded = true; refreshArchive(); }
    if (name === 'account') { loadAccounts(); }
    if (name === 'audit') { auditLoaded = true; refreshAudit(); }
    if (name === 'prize') { prizeLoaded = true; loadPrizes(); }
    if (on) { try { window.scrollTo(0, 0); } catch (e) { /* 忽略 */ } }
  }

  function refreshArchive() {
    if (!token) return;
    var q = '/api/archive/summary?token=' + encodeURIComponent(token) +
      (archiveDate ? '&date=' + encodeURIComponent(archiveDate) : '');
    fetch(q, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          if (d && d.code === 'unauthorized') forceLogout();
          return;
        }
        $('arSessions').textContent = d.sessions || 0;
        $('arRounds').textContent = d.rounds || 0;
        $('arMembers').textContent = d.members || 0;
        var inp = $('archiveDate');
        // 未指定日期时把服务端口径的「今天」回填，避免空白日期造成误解
        if (!archiveDate && d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) inp.value = d.date;
      })
      .catch(function () {});
  }

  function exportArchive(level) {
    if (!token) return;
    var q = '/api/archive/export.csv?level=' + encodeURIComponent(level) +
      '&token=' + encodeURIComponent(token) +
      (archiveDate ? '&date=' + encodeURIComponent(archiveDate) : '');
    var a = document.createElement('a');
    a.href = q;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast(t('toastExportStarted'), 'ok');
  }

  $('entryArchive').addEventListener('click', function () { showView('archive'); });
  $('archiveBack').addEventListener('click', function () { showView(''); });
  $('archiveDate').addEventListener('change', function () {
    archiveDate = this.value || '';
    refreshArchive();
  });
  Array.prototype.forEach.call(document.querySelectorAll('#archiveView .arch-actions button'), function (b) {
    b.addEventListener('click', function () { exportArchive(b.getAttribute('data-level')); });
  });

  /* ② 大屏：新窗口打开，带上当前场次 + 员工令牌（大屏侧会立即把令牌从地址栏抹掉） */
  $('entryBoard').addEventListener('click', function () {
    var cur = currentSession();
    if (!token || !cur || cur.status !== 'open') { toast(t('adminNeedSession'), 'err'); return; }
    window.open('/bigscreen?token=' + encodeURIComponent(token) +
      '&sid=' + encodeURIComponent(cur.id), '_blank', 'noopener');
  });

  /* ③ 新建场次 */
  $('entryCreate').addEventListener('click', function () {
    confirmModal({
      type: 'plain',
      title: t('sessionCreate'),
      body: t('adminCreateDesc'),
      input: true,
      placeholder: t('sessionNamePlaceholder'),
      okText: t('sessionCreateOk'),
      cancelText: t('modalCancelText')
    }).then(function (name) {
      if (name === false) return;
      return postJson('/api/session-create', { token: token, name: name }).then(function (d) {
        if (d && d.ok) {
          sessions = d.sessions || [];
          sid = d.sid || '';
          toast(t('toastSessionCreated', { name: (d.session && d.session.name) || '' }), 'ok');
          render();
        } else if (d && d.code === 'unauthorized') { forceLogout(); }
        else { toast(window.I18N.errCode(d && d.code, d) || t('errOpFailed'), 'err'); }
      });
    }).catch(function () { toast(t('errNetRetry'), 'err'); });
  });

  /* ④ 关闭场次（只关当前归属场次） */
  $('entryClose').addEventListener('click', function () {
    var cur = currentSession();
    if (!cur || cur.status !== 'open') { toast(t('adminNeedSession'), 'err'); return; }
    confirmModal({
      type: 'warn',
      title: t('modalCloseSessionTitle'),
      body: t('modalCloseSessionBody', { name: esc(cur.name) }),
      okText: t('modalCloseSessionOk'),
      cancelText: t('modalCancelText')
    }).then(function (sure) {
      if (!sure) return;
      return postJson('/api/session-close', { token: token, sid: cur.id }).then(function (d) {
        if (d && d.ok) {
          sessions = d.sessions || [];
          sid = d.nextSid || '';
          toast(t('toastSessionClosed', { name: cur.name }), 'ok');
          render();
        } else if (d && d.code === 'unauthorized') { forceLogout(); }
        else { toast(window.I18N.errCode(d && d.code, d) || t('errOpFailed'), 'err'); }
      });
    }).catch(function () { toast(t('errNetRetry'), 'err'); });
  });

  /* ---------- ⑤ 员工账号（一人一账号一密码） ---------- */
  var accounts = [];
  var acRole = 'staff';

  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function loadAccounts() {
    if (!token) return Promise.resolve();
    return fetch('/api/accounts?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { if (d && d.code === 'unauthorized') forceLogout(); return; }
        accounts = d.accounts || [];
        if (d.me) { me.username = d.me; renderUserChip(); }
        renderAccounts();
      })
      .catch(function () {});
  }

  function renderAccounts() {
    var box = $('accountList');
    if (!accounts.length) {
      box.innerHTML = '<div class="empty">' + esc(t('accountEmpty')) + '</div>';
      return;
    }
    box.innerHTML = accounts.map(function (a) {
      var isMe = a.username === me.username;
      var rolePill = '<span class="pill">' +
        esc(t(a.role === 'admin' ? 'accountRoleAdmin' : 'accountRoleStaff')) + '</span>';
      var stPill = '<span class="pill' + (a.status === 'active' ? '' : ' off') + '">' +
        esc(t(a.status === 'active' ? 'accountStatusActive' : 'accountStatusDisabled')) + '</span>';
      var mePill = isMe ? '<span class="pill me">' + esc(t('accountSelf')) + '</span>' : '';
      var acts = '<button class="mini-btn" type="button" data-act="pwd" data-user="' + esc(a.username) + '">' +
        esc(t('accountSetPwd')) + '</button>';
      if (a.status === 'active') {
        // 不允许在界面上停用自己（服务端同样拒绝，这里只是少一次报错）
        if (!isMe) {
          acts += '<button class="mini-btn warn" type="button" data-act="disable" data-user="' +
            esc(a.username) + '">' + esc(t('accountDisable')) + '</button>';
        }
      } else {
        acts += '<button class="mini-btn good" type="button" data-act="enable" data-user="' +
          esc(a.username) + '">' + esc(t('accountEnable')) + '</button>';
      }
      return '<div class="row-item">' +
        '<div class="ri-main">' +
          '<div class="ri-name">' + esc(a.displayName || a.username) + rolePill + stPill + mePill + '</div>' +
          '<div class="ri-sub">' + esc(a.username) + '</div>' +
          '<div class="ri-sub">' + esc(t('accountColLast')) + ' ' +
            esc(a.lastLoginAt ? fmtTime(a.lastLoginAt) : t('accountNever')) + '</div>' +
        '</div>' +
        '<div class="ri-acts">' + acts + '</div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var user = b.getAttribute('data-user');
        var act = b.getAttribute('data-act');
        if (act === 'pwd') resetPassword(user);
        else if (act === 'disable') disableAccount(user);
        else doUpdateAccount(user, { status: 'active' });
      });
    });
  }

  function openAccountForm() {
    $('accountForm').classList.remove('hidden');
    $('acUser').value = '';
    $('acName').value = '';
    $('acPwd').value = '';
    $('acErr').textContent = '';
    acRole = 'staff';
    Array.prototype.forEach.call($('acRole').querySelectorAll('button'), function (x) {
      x.classList.toggle('on', x.getAttribute('data-role') === 'staff');
    });
    setTimeout(function () { try { $('acUser').focus(); } catch (e) { /* 忽略 */ } }, 120);
  }

  function closeAccountForm() {
    $('accountForm').classList.add('hidden');
  }

  $('entryAccount').addEventListener('click', function () { showView('account'); });
  $('accountBack').addEventListener('click', function () { closeAccountForm(); showView(''); });
  $('accountAddBtn').addEventListener('click', openAccountForm);
  $('acCancel').addEventListener('click', closeAccountForm);

  Array.prototype.forEach.call($('acRole').querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () {
      acRole = b.getAttribute('data-role');
      Array.prototype.forEach.call($('acRole').querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x === b);
      });
    });
  });

  $('acSave').addEventListener('click', function () {
    var user = $('acUser').value.trim().toLowerCase();
    var name = $('acName').value.trim();
    var pwd = $('acPwd').value;
    $('acErr').textContent = '';
    if (!user) { $('acErr').textContent = t('errEmptyUser'); return; }
    if (!pwd) { $('acErr').textContent = t('errEmptyPwd'); return; }
    $('acSave').disabled = true;
    postJson('/api/account-create', {
      token: token, username: user, displayName: name, password: pwd, role: acRole
    }).then(function (d) {
      if (d && d.ok) {
        accounts = d.accounts || accounts;
        renderAccounts();
        closeAccountForm();
        toast(t('toastAccountCreated', { name: user }), 'ok');
      } else if (d && d.code === 'unauthorized') { forceLogout(); }
      else { $('acErr').textContent = window.I18N.errCode(d && d.code, d) || t('errOpFailed'); }
    }).catch(function () { $('acErr').textContent = t('errNetRetry'); })
      .finally(function () { $('acSave').disabled = false; });
  });

  function doUpdateAccount(user, fields) {
    var body = { token: token, username: user };
    Object.keys(fields).forEach(function (k) { body[k] = fields[k]; });
    return postJson('/api/account-update', body).then(function (d) {
      if (d && d.ok) {
        accounts = d.accounts || accounts;
        renderAccounts();
        toast(t('toastAccountUpdated'), 'ok');
        if (d.self) forceLogout();
      } else if (d && d.code === 'unauthorized') { forceLogout(); }
      else { toast(window.I18N.errCode(d && d.code, d) || t('errOpFailed'), 'err'); }
    }).catch(function () { toast(t('errNetRetry'), 'err'); });
  }

  function disableAccount(user) {
    confirmModal({
      type: 'warn',
      title: t('accountDisable'),
      body: esc(user),
      okText: t('accountDisable'),
      cancelText: t('modalCancelText')
    }).then(function (sure) {
      if (!sure) return;
      doUpdateAccount(user, { status: 'disabled' });
    });
  }

  function resetPassword(user) {
    confirmModal({
      type: 'plain',
      title: t('accountSetPwdTitle'),
      body: t('accountSetPwdHint'),
      input: true,
      password: true,
      placeholder: t('accountPwdPh'),
      okText: t('accountSetPwd'),
      cancelText: t('modalCancelText')
    }).then(function (pwd) {
      if (pwd === false) return;
      if (!pwd) { toast(t('errEmptyPwd'), 'err'); return; }
      return postJson('/api/account-password', { token: token, username: user, password: pwd })
        .then(function (d) {
          if (d && d.ok) {
            toast(t('toastPwdReset'), 'ok');
            if (d.self) forceLogout();
            else loadAccounts();
          } else if (d && d.code === 'unauthorized') { forceLogout(); }
          else { toast(window.I18N.errCode(d && d.code, d) || t('errOpFailed'), 'err'); }
        });
    });
  }

  /* ---------- ⑥ 操作日志 ---------- */
  var auditDate = '';
  var auditLoaded = false;

  function actionLabel(code) {
    var key = 'action_' + code;
    var v = t(key);
    return v === key ? code : v;    // 未知动作直接显示 code，不吞信息
  }

  function refreshAudit() {
    if (!token) return;
    var q = '/api/audit?token=' + encodeURIComponent(token) +
      (auditDate ? '&date=' + encodeURIComponent(auditDate) : '') + '&limit=300';
    fetch(q, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { if (d && d.code === 'unauthorized') forceLogout(); return; }
        if (!auditDate && d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) $('auditDate').value = d.date;
        renderAudit(d.rows || []);
      })
      .catch(function () {});
  }

  function fmtClock(ms) {
    var d = new Date(ms);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function renderAudit(rows) {
    var box = $('auditList');
    $('auditHint').textContent = t('auditCount', { n: rows.length });
    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + esc(t('auditEmpty')) + '</div>';
      return;
    }
    box.innerHTML = rows.map(function (r) {
      var sub = [];
      if (r.target) sub.push(esc(r.target));
      if (r.sid) sub.push('sid ' + esc(r.sid));
      if (r.ip) sub.push(esc(r.ip));
      var extra = r.detail
        ? ' <span title="' + esc(JSON.stringify(r.detail)) + '" style="color:var(--muted)">ⓘ</span>' : '';
      return '<div class="log-item">' +
        '<div class="li-top">' +
          '<span class="li-time" title="' + esc(fmtTime(r.at)) + '">' + esc(fmtClock(r.at)) + '</span>' +
          '<span class="li-who">' + esc(r.actor || '—') + '</span>' +
          '<span class="li-act">' + esc(actionLabel(r.action)) + '</span>' + extra +
        '</div>' +
        (sub.length ? '<div class="li-sub">' + sub.join(' · ') + '</div>' : '') +
      '</div>';
    }).join('');
  }

  $('entryAudit').addEventListener('click', function () { showView('audit'); });
  $('auditBack').addEventListener('click', function () { showView(''); });
  $('auditDate').addEventListener('change', function () {
    auditDate = this.value || '';
    refreshAudit();
  });
  $('auditExportBtn').addEventListener('click', function () {
    if (!token) return;
    var q = '/api/audit/export.csv?token=' + encodeURIComponent(token) +
      (auditDate ? '&date=' + encodeURIComponent(auditDate) : '');
    var a = document.createElement('a');
    a.href = q;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast(t('toastAuditExported'), 'ok');
  });

  /* ---------- 奖品设置 ---------- */
  /* 四档文案是全局配置（不按场次），保存后只对之后新建的场次生效。
   *
   * 每档的「奖品名称 / 奖品说明」都要按三种语言各存一份：
   *   prizes[tier].title = { 'zh-CN': '', 'zh-HK': '', 'en-US': '' }
   *   prizes[tier].desc  = 同上（bonus 区块同构，另加 number）
   * 玩家端按它当前选的语言取对应的那一键，缺语言时按固定顺序回退。
   *
   * 三语完整性：**只要这一档开始配置，名称就必须三语齐全**；说明要么三语都填、要么都不填。
   * 前端先拦（并把缺的那一栏标红，让人一眼看到缺哪种语言），服务端再拦一次
   * （400 / prize_incomplete），两边规则必须一致，避免「前端放过、后端 500」。
   */
  var PRIZE_LOCALES = ['zh-CN', 'zh-HK', 'en-US'];

  /* 档位 × 语言 → [名称输入框 id, 说明输入框 id]。全部写死，避免用下标拼 id 拼错。 */
  var PRIZE_FIELDS = {
    both: {
      'zh-CN': ['pzBothTitleZhCN', 'pzBothDescZhCN'],
      'zh-HK': ['pzBothTitleZhHK', 'pzBothDescZhHK'],
      'en-US': ['pzBothTitleEnUS', 'pzBothDescEnUS']
    },
    number: {
      'zh-CN': ['pzNumberTitleZhCN', 'pzNumberDescZhCN'],
      'zh-HK': ['pzNumberTitleZhHK', 'pzNumberDescZhHK'],
      'en-US': ['pzNumberTitleEnUS', 'pzNumberDescEnUS']
    },
    oddeven: {
      'zh-CN': ['pzOddevenTitleZhCN', 'pzOddevenDescZhCN'],
      'zh-HK': ['pzOddevenTitleZhHK', 'pzOddevenDescZhHK'],
      'en-US': ['pzOddevenTitleEnUS', 'pzOddevenDescEnUS']
    },
    miss: {
      'zh-CN': ['pzMissTitleZhCN', 'pzMissDescZhCN'],
      'zh-HK': ['pzMissTitleZhHK', 'pzMissDescZhHK'],
      'en-US': ['pzMissTitleEnUS', 'pzMissDescEnUS']
    }
  };
  /* 全员额外奖励的三语文案（特殊数字单独一个下拉框） */
  var BONUS_FIELDS = {
    'zh-CN': ['bzTitleZhCN', 'bzDescZhCN'],
    'zh-HK': ['bzTitleZhHK', 'bzDescZhHK'],
    'en-US': ['bzTitleEnUS', 'bzDescEnUS']
  };
  /* 档位 → i18n 键（错误提示里要报「哪一档」） */
  var PRIZE_TIER_I18N = {
    both: 'prizeTierBoth',
    number: 'prizeTierNumber',
    oddeven: 'prizeTierOddeven',
    miss: 'prizeTierMiss',
    bonus: 'bonusTitle'
  };
  var PRIZE_LOCALE_I18N = { 'zh-CN': 'pzLangZhCN', 'zh-HK': 'pzLangZhHK', 'en-US': 'pzLangEnUS' };

  /* 三语示例占位符：示例本身就是「那一种语言的内容」，不随界面语言切换，
   * 所以不挂 data-i18n-placeholder，由这里按栏固定。 */
  var PRIZE_PLACEHOLDER = {
    'zh-CN': { title: '例如：羊绒围巾一条', desc: '例如：凭本页面到前台领取，当日有效' },
    'zh-HK': { title: '例如：羊絨圍巾一條', desc: '例如：憑本頁面到前台領取，當日有效' },
    'en-US': { title: 'e.g. Wool scarf', desc: 'e.g. Show this page at the counter, valid today' }
  };

  function applyPrizePlaceholders() {
    Object.keys(PRIZE_FIELDS).forEach(function (tier) {
      PRIZE_LOCALES.forEach(function (loc) {
        var ids = PRIZE_FIELDS[tier][loc];
        var ph = PRIZE_PLACEHOLDER[loc];
        $(ids[0]).placeholder = ph.title;
        $(ids[1]).placeholder = ph.desc;
      });
    });
    PRIZE_LOCALES.forEach(function (loc) {
      var ids = BONUS_FIELDS[loc];
      var ph = PRIZE_PLACEHOLDER[loc];
      $(ids[0]).placeholder = ph.title;
      $(ids[1]).placeholder = ph.desc;
    });
  }

  var prizeLoaded = false;

  /** 取三语字段里的某一语言（服务端已归一化成对象；兼容旧版单语字符串，落到简体） */
  function localizedValue(field, loc) {
    if (!field) return '';
    if (typeof field === 'string') return loc === 'zh-CN' ? field : '';
    return field[loc] || '';
  }

  /* 规则版本：只显示版本号，多解释一句「只对新建场次生效」——
   * 这是运营最容易误解的地方（以为一保存玩家端就变），所以写在保存按钮上方。 */
  function showRuleVersion(version) {
    var n = Number(version);
    $('prizeRuleVerNo').textContent = (Number.isInteger(n) && n > 0) ? ('v' + n) : '—';
  }

  function fillPrizeForm(prizes) {
    Object.keys(PRIZE_FIELDS).forEach(function (tier) {
      var cfg = (prizes && prizes[tier]) || {};
      PRIZE_LOCALES.forEach(function (loc) {
        var ids = PRIZE_FIELDS[tier][loc];
        $(ids[0]).value = localizedValue(cfg.title, loc);
        $(ids[1]).value = localizedValue(cfg.desc, loc);
      });
    });
  }

  /* 额外奖品：特殊数字 + 全员加奖文案（三语），与四档独立。
   * 「不启用」用空值表达——0 现在是合法特殊数字，不能再用 0 当哨兵。 */
  function fillBonusForm(bonus) {
    var b = bonus || {};
    var n = b.number == null ? null : Number(b.number);
    $('bzNumber').value = (Number.isInteger(n) && n >= 0 && n <= 9) ? String(n) : '';
    PRIZE_LOCALES.forEach(function (loc) {
      var ids = BONUS_FIELDS[loc];
      $(ids[0]).value = localizedValue(b.title, loc);
      $(ids[1]).value = localizedValue(b.desc, loc);
    });
  }

  /* ---- 三语校验 ---- */

  /** 清掉上一轮的标红 */
  function clearPrizeBad() {
    $('prizeErr').textContent = '';
    document.querySelectorAll('#prizeView .bad').forEach(function (el) {
      el.classList.remove('bad');
    });
  }

  /**
   * 一档的三语判定，缺语言的输入框 id 收进 problems。
   * 整档六格全空 → 合法（玩家端不显示该档奖品卡）；否则名称三语必须齐，说明要么全填要么全空。
   */
  function collectTierProblems(problems, tier, ids, title, desc) {
    var used = PRIZE_LOCALES.some(function (loc) { return title[loc] || desc[loc]; });
    if (!used) return;
    var missTitle = PRIZE_LOCALES.filter(function (loc) { return !title[loc]; });
    if (missTitle.length) {
      problems.push({
        tier: tier, field: 'title', langs: missTitle,
        ids: missTitle.map(function (loc) { return ids[loc][0]; })
      });
    }
    var descFilled = PRIZE_LOCALES.filter(function (loc) { return desc[loc]; });
    if (descFilled.length && descFilled.length < PRIZE_LOCALES.length) {
      var missDesc = PRIZE_LOCALES.filter(function (loc) { return !desc[loc]; });
      problems.push({
        tier: tier, field: 'desc', langs: missDesc,
        ids: missDesc.map(function (loc) { return ids[loc][1]; })
      });
    }
  }

  /**
   * 收集整张表单 → { prizes, bonus, problems }。
   * 只做收集，不落库；problems 非空时调用方必须拦截，不许发请求。
   */
  function collectPrizeForm() {
    var prizes = {};
    var problems = [];
    Object.keys(PRIZE_FIELDS).forEach(function (tier) {
      var title = {};
      var desc = {};
      PRIZE_LOCALES.forEach(function (loc) {
        var ids = PRIZE_FIELDS[tier][loc];
        title[loc] = $(ids[0]).value.trim();
        desc[loc] = $(ids[1]).value.trim();
      });
      prizes[tier] = { title: title, desc: desc };
      collectTierProblems(problems, tier, PRIZE_FIELDS[tier], title, desc);
    });

    var bonusTitle = {};
    var bonusDesc = {};
    PRIZE_LOCALES.forEach(function (loc) {
      var ids = BONUS_FIELDS[loc];
      bonusTitle[loc] = $(ids[0]).value.trim();
      bonusDesc[loc] = $(ids[1]).value.trim();
    });
    collectTierProblems(problems, 'bonus', BONUS_FIELDS, bonusTitle, bonusDesc);

    var bzRaw = $('bzNumber').value;
    var bonus = {
      number: bzRaw === '' ? null : Number(bzRaw),
      title: bonusTitle,
      desc: bonusDesc
    };
    return { prizes: prizes, bonus: bonus, problems: problems };
  }

  /** 把校验结果翻成「哪一档 · 哪个字段 · 缺哪几种语言」的文字，并标红对应输入框 */
  function showPrizeProblems(problems) {
    problems.forEach(function (p) {
      p.ids.forEach(function (id) { if ($(id)) $(id).classList.add('bad'); });
    });
    $('prizeErr').textContent = problems.map(function (p) {
      return t('prizeNeedAllLangs', {
        tier: t(PRIZE_TIER_I18N[p.tier]),
        field: t(p.field === 'title' ? 'prizeNameLab' : 'prizeDescLab'),
        langs: p.langs.map(function (loc) { return t(PRIZE_LOCALE_I18N[loc]); }).join(' / ')
      });
    }).join('\n');
  }

  function loadBonus() {
    if (!token) return;
    fetch('/api/bonus-prize?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          if (d && d.code === 'unauthorized') { forceLogout(); return; }
          return;
        }
        fillBonusForm(d.bonus);
        showRuleVersion(d.ruleVersion);
      })
      .catch(function () { /* 读失败不打扰：保留表单现状 */ });
  }

  function loadPrizes() {
    if (!token) return;
    clearPrizeBad();
    fetch('/api/prize-config?token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          if (d && d.code === 'unauthorized') { forceLogout(); return; }
          $('prizeErr').textContent = t('prizeLoadFail');
          return;
        }
        fillPrizeForm(d.prizes);
        showRuleVersion(d.ruleVersion);
      })
      .catch(function () { $('prizeErr').textContent = t('prizeLoadFail'); });
    loadBonus();
  }

  $('entryPrize').addEventListener('click', function () { showView('prize'); });
  $('prizeBack').addEventListener('click', function () { showView(''); });

  $('prizeSave').addEventListener('click', function () {
    if (!token) return;
    // 先本地校验三语完整性：缺语言就别发请求，直接把缺的那几栏标红
    clearPrizeBad();
    var form = collectPrizeForm();
    if (form.problems.length) {
      showPrizeProblems(form.problems);
      return;
    }
    var btn = $('prizeSave');
    btn.disabled = true;
    postJson('/api/prize-config', { token: token, prizes: form.prizes })
      .then(function (d) {
        if (!d || !d.ok) {
          if (d && d.code === 'unauthorized') forceLogout();
          // 服务端也校验三语（前端被绕过时唯一的防线）：把缺失项照样标红
          else if (d && d.code === 'prize_incomplete' && Array.isArray(d.missing)) {
            showPrizeProblems(d.missing.map(withFieldIds('prize')));
          } else $('prizeErr').textContent = t('prizeSaveFail');
          return;
        }
        fillPrizeForm(d.prizes);
        showRuleVersion(d.ruleVersion);
        // 四档保存成功后，再保存额外奖品（独立接口，失败单独提示）
        return postJson('/api/bonus-prize', { token: token, bonus: form.bonus });
      })
      .then(function (d2) {
        if (d2 && d2.ok) {
          fillBonusForm(d2.bonus);
          showRuleVersion(d2.ruleVersion);
          toast(t('prizeSaved'), 'ok');
        }
        else if (d2 && d2.code === 'unauthorized') forceLogout();
        else if (d2 && d2.code === 'bonus_incomplete' && Array.isArray(d2.missing)) {
          showPrizeProblems(d2.missing.map(withFieldIds('bonus')));
        }
        else if (d2) $('prizeErr').textContent = t('bonusSaveFail');
      })
      .catch(function () { $('prizeErr').textContent = t('prizeSaveFail'); })
      .finally(function () { btn.disabled = false; });
  });

  /** 服务端返回的缺失项只有 { tier, field, locales }，补上输入框 id 才能标红 */
  function withFieldIds(kind) {
    return function (p) {
      var map = (kind === 'bonus' || p.tier === 'bonus') ? BONUS_FIELDS : PRIZE_FIELDS[p.tier];
      var idx = p.field === 'title' ? 0 : 1;
      return {
        tier: p.tier,
        field: p.field,
        langs: p.locales || [],
        ids: (p.locales || []).map(function (loc) { return map[loc][idx]; })
      };
    };
  }

  /* ---------- 启动 ---------- */
  function boot() {
    var urlToken = '';
    try { urlToken = new URLSearchParams(location.search).get('token') || ''; } catch (e) { urlToken = ''; }

    if (urlToken) {
      // 从别处带 token 进来：只存本地，并立刻从地址栏抹掉（避免留在历史记录里）
      saveToken(urlToken);
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* 忽略 */ }
    } else {
      try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
      if (!token) {
        // 同标签页从员工端跳过来：直接沿用那份登录态
        try { token = sessionStorage.getItem(STAFF_TOKEN_KEY) || ''; } catch (e) { token = ''; }
      }
    }
    checkAuth();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && token) {
      refreshSessions();
      if (archiveLoaded) refreshArchive();
      if (auditLoaded) refreshAudit();
      if (prizeLoaded) loadPrizes();
    }
  });

  updateLangButton();
  applyStaticI18n();
  applyPrizePlaceholders();
  boot();
})();
