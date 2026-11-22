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
  /* 四档文案是全局配置（不按场次），保存后服务端把新快照推给所有在线玩家端。
   * 档位输入框一一对应，避免用下标猜字段。 */
  var PRIZE_FIELDS = {
    both: ['pzBothTitle', 'pzBothDesc'],
    number: ['pzNumberTitle', 'pzNumberDesc'],
    oddeven: ['pzOddevenTitle', 'pzOddevenDesc'],
    miss: ['pzMissTitle', 'pzMissDesc']
  };
  var prizeLoaded = false;

  /* 规则版本：只显示版本号，多解释一句「只对新建场次生效」——
   * 这是运营最容易误解的地方（以为一保存玩家端就变），所以写在保存按钮上方。 */
  function showRuleVersion(version) {
    var n = Number(version);
    $('prizeRuleVerNo').textContent = (Number.isInteger(n) && n > 0) ? ('v' + n) : '—';
  }

  function fillPrizeForm(prizes) {
    Object.keys(PRIZE_FIELDS).forEach(function (tier) {
      var ids = PRIZE_FIELDS[tier];
      var cfg = (prizes && prizes[tier]) || {};
      $(ids[0]).value = cfg.title || '';
      $(ids[1]).value = cfg.desc || '';
    });
  }

  /* 额外奖品：特殊数字 + 全员加奖文案，与四档独立。
   * 「不启用」用空值表达——0 现在是合法特殊数字，不能再用 0 当哨兵。 */
  function fillBonusForm(bonus) {
    var b = bonus || {};
    var n = b.number == null ? null : Number(b.number);
    $('bzNumber').value = (Number.isInteger(n) && n >= 0 && n <= 9) ? String(n) : '';
    $('bzTitle').value = b.title || '';
    $('bzDesc').value = b.desc || '';
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
    $('prizeErr').textContent = '';
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
    var prizes = {};
    Object.keys(PRIZE_FIELDS).forEach(function (tier) {
      var ids = PRIZE_FIELDS[tier];
      prizes[tier] = { title: $(ids[0]).value.trim(), desc: $(ids[1]).value.trim() };
    });
    var bzRaw = $('bzNumber').value;
    var bonus = {
      number: bzRaw === '' ? null : Number(bzRaw),
      title: $('bzTitle').value.trim(),
      desc: $('bzDesc').value.trim()
    };
    var btn = $('prizeSave');
    btn.disabled = true;
    $('prizeErr').textContent = '';
    postJson('/api/prize-config', { token: token, prizes: prizes })
      .then(function (d) {
        if (!d || !d.ok) {
          if (d && d.code === 'unauthorized') forceLogout();
          else $('prizeErr').textContent = t('prizeSaveFail');
          return;
        }
        fillPrizeForm(d.prizes);
        showRuleVersion(d.ruleVersion);
        // 四档保存成功后，再保存额外奖品（独立接口，失败单独提示）
        return postJson('/api/bonus-prize', { token: token, bonus: bonus });
      })
      .then(function (d2) {
        if (d2 && d2.ok) {
          fillBonusForm(d2.bonus);
          showRuleVersion(d2.ruleVersion);
          toast(t('prizeSaved'), 'ok');
        }
        else if (d2 && d2.code === 'unauthorized') forceLogout();
        else if (d2) $('prizeErr').textContent = t('bonusSaveFail');
      })
      .catch(function () { $('prizeErr').textContent = t('prizeSaveFail'); })
      .finally(function () { btn.disabled = false; });
  });

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
  boot();
})();
