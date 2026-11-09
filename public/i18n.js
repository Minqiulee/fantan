/* =========================================================================
 * 单双竞猜 · 多语言资源（i18n）—— 工作人员端 + 玩家端共用
 * -------------------------------------------------------------------------
 * 组织方式：
 *   1. 三种语言各为一个独立键值对象（zh-CN / zh-HK / en-US），
 *      键名（key）完全一致，便于逐条核对与维护。
 *   2. 所有界面文本、提示、按钮、菜单、错误提示均集中于此，
 *      前端只通过 t(key) 或 data-i18n 属性引用，不散落硬编码。
 *   3. 命名空间：工作人员端用平铺 key，玩家端 key 统一以 "p_" 前缀区分，
 *      两端共用同一套加载与切换逻辑，互不干扰。
 *   4. 新增语言：复制 zh-CN 对象 → 改名 → 逐条翻译即可，无需改动页面。
 *   5. 语言选择持久化到 localStorage，并在 <html lang> 上同步更新。
 *      storage key 由页面通过 init({ storageKey }) 指定，两端各自独立。
 * ========================================================================= */
(function (global) {
  'use strict';

  var LOCALES = {
    'zh-CN': {
      /* ================= 工作人员端 ================= */
      brand: '羊多一点',
      staffTag: '工作人员端',

      loginTitle: '工作人员登录',
      pwdPlaceholder: '管理密码',
      unlock: '解锁',
      errEmptyPwd: '请输入密码',
      errLoginFailed: '登录失败',
      errNetRetry: '网络异常，请重试',
      errSessionExpired: '会话已失效，请重新登录',

      roundInfo: '第 {round} 轮',
      roundLocked: '已开奖',
      roundOngoing: '进行中',
      statusLocked: '已确认',
      statusInput: '待录入',

      overview: '本轮概况',
      cntReg: '已扫码玩家',
      cntPred: '已提交预测',

      playerListTitle: '本轮玩家',
      plistCount: '共 {total} 人 · 新 {new} / 老 {vet}',
      tagVet: '老玩家',
      tagNew: '新玩家',
      noPlayerYet: '本轮还没有玩家扫码',
      noName: '（未命名）',
      noNameBound: '（未绑称呼）',

      inputTitle: '录入本轮数字',
      selPreview: '已选数字',
      confirmLock: '确认并锁定本轮数字',
      errPickNumber: '请先点选一个 1-8 的数字',
      confirmDialog: '确认本轮数字为「{number}」吗？\n确认后立即锁定并开奖，不可修改或重复录入。',
      toastLocked: '已锁定，本轮数字：{number}',
      errConfirmFailed: '确认失败',

      lockedBanner: '✓ 本轮数字已确认并锁定',
      resetRound: '开始新一轮',
      resetDialog: '开始新一轮吗？\n本轮的登记与预测记录将被清空，玩家需重新登记。',
      toastNewRound: '已进入第 {round} 轮，等待录入',
      errOpFailed: '操作失败',
      noPlayerReg: '本轮没有玩家登记',

      thPlayer: '玩家',
      thOddEven: '单双',
      thNumber: '数字',
      thOddEvenResult: '单双结果',
      thNumberResult: '数字结果',
      hit: '命中',
      miss: '未中',
      odd: '单',
      even: '双',

      connLost: '⚠ 连接中断，正在重试…',
      logout: '退出登录',
      toastNumberLocked: '数字已锁定：{number}，玩家端已同步开奖',

      err_bad_request: '请求格式错误',
      err_too_many_attempts: '尝试次数过多，请 {retryAfter} 秒后再试',
      err_wrong_password: '密码错误',
      err_unauthorized: '未授权，请先登录员工端',
      err_invalid_number: '只能录入 1-8 的整数',
      err_already_locked: '本轮数字已锁定为 {number}，不能重复录入；如需继续请开始新一轮',

      /* ================= 玩家端 ================= */
      p_title: '羊多一点',
      p_tag: '玩家端',
      p_logout: '登出',
      p_round: '第 {n} 轮',
      p_inProgress: ' · 进行中',
      p_locked: ' · 已开奖',
      p_st_unreg: '未登记 · 待扫码',
      p_st_ready: '已登记 · 待预测',
      p_st_wait: '已预测 · 等待开奖',
      p_st_done: '已出结果',

      p_scanTitle: '扫描我的二维码',
      p_openCam: '打开相机扫描',
      p_camTip: '对准你手中的二维码，自动识别',
      p_camStarting: '正在启动相机…',
      p_camDenied: '相机权限被拒绝，请在浏览器设置中允许访问相机，或改用下方手动输入',
      p_camNotFound: '未检测到相机设备，请改用下方手动输入',
      p_camBusy: '相机被其他应用占用，请关闭后重试，或改用手动输入',
      p_camUnavailable: '相机扫描不可用，请改用下方手动输入',
      p_manualSummary: '手动输入会员号码',
      p_manualPlaceholder: '会员号码',
      p_manualBtn: '提交识别',

      p_predTitle: '提交预测',
      p_predBtn: '提交预测',
      p_predHint: '单双 + 数字各预测一次，一次提交、不可修改。',
      p_oeCol: '单双',
      p_numCol: '数字',

      p_waitTitle: '已提交 · 等待工作人员开奖',
      p_waitHint: '工作人员确认前不会公布数字，请耐心等待～',

      p_resultLab: '本轮开奖数字',
      p_oePred: '单双预测',
      p_numPred: '数字预测',
      p_resultHint: '等待工作人员开始新一轮。',
      p_guessOE: '猜「{x}」→ {r}',
      p_hitYes: '✓ 命中',
      p_hitNo: '✗ 未中',

      p_welcome: '欢迎回来，{n}！',
      p_scanned: '二维码已识别 {id}',
      p_manualEmpty: '请输入二维码内容或编号',
      p_scanNetErr: '网络异常，请重试',
      p_scanFail: '识别失败',
      p_selOddEven: '请先选择「单」或「双」',
      p_selNum: '请再选一个 1-8 的数字',
      p_predSubmitting: '预测已提交，等待开奖！',
      p_predSubmitFail: '提交失败',
      p_logoutConfirm: '确认登出？将清除本机身份，需重新扫码。',
      p_loggedOut: '已登出',

      /* 玩家端服务端错误码（/api/scan、/api/predict 返回） */
      p_err_bad_request: '请求格式错误',
      p_err_scan_empty: '二维码内容为空，请重新扫描',
      p_err_scan_too_long: '二维码内容超长（>{maxLen} 字符），无法登记',
      p_err_scan_locked: '本轮已开奖，新二维码无法入场，请等待工作人员开始新一轮',
      p_err_predict_not_scanned: '请先扫描你的二维码',
      p_err_predict_closed: '本轮已开奖，预测已截止',
      p_err_predict_duplicate: '你已提交过预测，不能重复提交或修改',
      p_err_predict_invalid_oe: '请选择「单」或「双」',
      p_err_predict_invalid: '数字预测必须是 1-8 的整数'
    },

    'zh-HK': {
      /* ================= 工作人員端 ================= */
      brand: '羊多一點',
      staffTag: '工作人員端',

      loginTitle: '工作人員登入',
      pwdPlaceholder: '管理密碼',
      unlock: '解鎖',
      errEmptyPwd: '請輸入密碼',
      errLoginFailed: '登入失敗',
      errNetRetry: '網絡異常，請重試',
      errSessionExpired: '會話已失效，請重新登入',

      roundInfo: '第 {round} 輪',
      roundLocked: '已開獎',
      roundOngoing: '進行中',
      statusLocked: '已確認',
      statusInput: '待錄入',

      overview: '本輪概況',
      cntReg: '已掃碼玩家',
      cntPred: '已提交預測',

      playerListTitle: '本輪玩家',
      plistCount: '共 {total} 人 · 新 {new} / 老 {vet}',
      tagVet: '老玩家',
      tagNew: '新玩家',
      noPlayerYet: '本輪還沒有玩家掃碼',
      noName: '（未命名）',
      noNameBound: '（未綁稱呼）',

      inputTitle: '錄入本輪數字',
      selPreview: '已選數字',
      confirmLock: '確認並鎖定本輪數字',
      errPickNumber: '請先點選一個 1-8 的數字',
      confirmDialog: '確認本輪數字為「{number}」嗎？\n確認後立即鎖定並開獎，不可修改或重複錄入。',
      toastLocked: '已鎖定，本輪數字：{number}',
      errConfirmFailed: '確認失敗',

      lockedBanner: '✓ 本輪數字已確認並鎖定',
      resetRound: '開始新一輪',
      resetDialog: '開始新一輪嗎？\n本輪的登記與預測記錄將被清空，玩家需重新登記。',
      toastNewRound: '已進入第 {round} 輪，等待錄入',
      errOpFailed: '操作失敗',
      noPlayerReg: '本輪沒有玩家登記',

      thPlayer: '玩家',
      thOddEven: '單雙',
      thNumber: '數字',
      thOddEvenResult: '單雙結果',
      thNumberResult: '數字結果',
      hit: '命中',
      miss: '未中',
      odd: '單',
      even: '雙',

      connLost: '⚠ 連接中斷，正在重試…',
      logout: '退出登入',
      toastNumberLocked: '數字已鎖定：{number}，玩家端已同步開獎',

      err_bad_request: '請求格式錯誤',
      err_too_many_attempts: '嘗試次數過多，請 {retryAfter} 秒後再試',
      err_wrong_password: '密碼錯誤',
      err_unauthorized: '未授權，請先登入員工端',
      err_invalid_number: '只能錄入 1-8 的整數',
      err_already_locked: '本輪數字已鎖定為 {number}，不能重複錄入；如需繼續請開始新一輪',

      /* ================= 玩家端 ================= */
      p_title: '羊多一點',
      p_tag: '玩家端',
      p_logout: '登出',
      p_round: '第 {n} 輪',
      p_inProgress: ' · 進行中',
      p_locked: ' · 已開獎',
      p_st_unreg: '未登記 · 待掃碼',
      p_st_ready: '已登記 · 待預測',
      p_st_wait: '已預測 · 等待開獎',
      p_st_done: '已出結果',

      p_scanTitle: '掃描我的二維碼',
      p_openCam: '打開相機掃描',
      p_camTip: '對準你手中的二維碼，自動識別',
      p_camStarting: '正在啟動相機…',
      p_camDenied: '相機權限被拒絕，請在瀏覽器設定中允許訪問相機，或改用下方手動輸入',
      p_camNotFound: '未偵測到相機裝置，請改用下方手動輸入',
      p_camBusy: '相機被其他應用程式佔用，請關閉後重試，或改用手動輸入',
      p_camUnavailable: '相機掃描不可用，請改用下方手動輸入',
      p_manualSummary: '手動輸入會員號碼',
      p_manualPlaceholder: '會員號碼',
      p_manualBtn: '提交識別',

      p_predTitle: '提交預測',
      p_predBtn: '提交預測',
      p_predHint: '單雙 + 數字各預測一次，一次提交、不可修改。',
      p_oeCol: '單雙',
      p_numCol: '數字',

      p_waitTitle: '已提交 · 等待工作人員開獎',
      p_waitHint: '工作人員確認前不會公布數字，請耐心等待～',

      p_resultLab: '本輪開獎數字',
      p_oePred: '單雙預測',
      p_numPred: '數字預測',
      p_resultHint: '等待工作人員開始新一輪。',
      p_guessOE: '猜「{x}」→ {r}',
      p_hitYes: '✓ 命中',
      p_hitNo: '✗ 未中',

      p_welcome: '歡迎回來，{n}！',
      p_scanned: '二維碼已識別 {id}',
      p_manualEmpty: '請輸入二維碼內容或編號',
      p_scanNetErr: '網絡異常，請重試',
      p_scanFail: '識別失敗',
      p_selOddEven: '請先選擇「單」或「雙」',
      p_selNum: '請再選一個 1-8 的數字',
      p_predSubmitting: '預測已提交，等待開獎！',
      p_predSubmitFail: '提交失敗',
      p_logoutConfirm: '確認登出？將清除本機身份，需重新掃碼。',
      p_loggedOut: '已登出',

      p_err_bad_request: '請求格式錯誤',
      p_err_scan_empty: '二維碼內容為空，請重新掃描',
      p_err_scan_too_long: '二維碼內容超長（>{maxLen} 字符），無法登記',
      p_err_scan_locked: '本輪已開獎，新二維碼無法入場，請等待工作人員開始新一輪',
      p_err_predict_not_scanned: '請先掃描你的二維碼',
      p_err_predict_closed: '本輪已開獎，預測已截止',
      p_err_predict_duplicate: '你已提交過預測，不能重複提交或修改',
      p_err_predict_invalid_oe: '請選擇「單」或「雙」',
      p_err_predict_invalid: '數字預測必須是 1-8 的整數'
    },

    'en-US': {
      /* ================= Staff Console ================= */
      brand: 'GOAT More',
      staffTag: 'Staff Console',

      loginTitle: 'Staff Login',
      pwdPlaceholder: 'Admin password',
      unlock: 'Unlock',
      errEmptyPwd: 'Please enter the password',
      errLoginFailed: 'Login failed',
      errNetRetry: 'Network error, please retry',
      errSessionExpired: 'Session expired, please log in again',

      roundInfo: 'Round {round}',
      roundLocked: 'Drawn',
      roundOngoing: 'In progress',
      statusLocked: 'Confirmed',
      statusInput: 'Pending entry',

      overview: 'This Round',
      cntReg: 'Scanned players',
      cntPred: 'Predictions submitted',

      playerListTitle: 'Players This Round',
      plistCount: '{total} total · {new} new / {vet} returning',
      tagVet: 'Returning',
      tagNew: 'New',
      noPlayerYet: 'No player has scanned in yet',
      noName: '(unnamed)',
      noNameBound: '(no alias bound)',

      inputTitle: 'Enter This Round\'s Number',
      selPreview: 'Selected number',
      confirmLock: 'Confirm & Lock Number',
      errPickNumber: 'Please tap a number from 1 to 8 first',
      confirmDialog: 'Confirm the number "{number}" for this round?\nIt will be locked and drawn immediately, and cannot be changed or re-entered.',
      toastLocked: 'Locked. This round\'s number: {number}',
      errConfirmFailed: 'Confirmation failed',

      lockedBanner: '✓ Number confirmed & locked',
      resetRound: 'Start New Round',
      resetDialog: 'Start a new round?\nThis round\'s registrations and predictions will be cleared; players must register again.',
      toastNewRound: 'Entered round {round}, awaiting entry',
      errOpFailed: 'Operation failed',
      noPlayerReg: 'No players registered this round',

      thPlayer: 'Player',
      thOddEven: 'Odd/Even',
      thNumber: 'Number',
      thOddEvenResult: 'Odd/Even',
      thNumberResult: 'Number',
      hit: 'Hit',
      miss: 'Miss',
      odd: 'Odd',
      even: 'Even',

      connLost: '⚠ Connection lost, retrying…',
      logout: 'Log out',
      toastNumberLocked: 'Number locked: {number}, players have been updated',

      err_bad_request: 'Malformed request',
      err_too_many_attempts: 'Too many attempts, please retry in {retryAfter} seconds',
      err_wrong_password: 'Incorrect password',
      err_unauthorized: 'Unauthorized, please log in to the staff console first',
      err_invalid_number: 'Please enter an integer from 1 to 8',
      err_already_locked: 'This round\'s number is already locked to {number}; start a new round to continue',

      /* ================= Player ================= */
      p_title: 'GOAT More',
      p_tag: 'Player',
      p_logout: 'Log out',
      p_round: 'Round {n}',
      p_inProgress: ' · In progress',
      p_locked: ' · Result out',
      p_st_unreg: 'Not registered · Scan',
      p_st_ready: 'Registered · Predict',
      p_st_wait: 'Predicted · Waiting',
      p_st_done: 'Result out',

      p_scanTitle: 'Scan my QR code',
      p_openCam: 'Open camera to scan',
      p_camTip: 'Point at your QR code to auto-recognize',
      p_camStarting: 'Starting camera…',
      p_camDenied: 'Camera permission denied. Allow camera access in browser settings, or enter manually below',
      p_camNotFound: 'No camera device found. Please enter manually below',
      p_camBusy: 'Camera is in use by another app. Close it and retry, or enter manually',
      p_camUnavailable: 'Camera scanning unavailable. Please enter manually below',
      p_manualSummary: 'Enter ID manually',
      p_manualPlaceholder: 'Enter ID',
      p_manualBtn: 'Submit',

      p_predTitle: 'Place your prediction',
      p_predBtn: 'Submit prediction',
      p_predHint: 'Predict odd/even and a number once each. One submission, no changes.',
      p_oeCol: 'Odd/Even',
      p_numCol: 'Number',

      p_waitTitle: 'Submitted · Waiting for staff to draw',
      p_waitHint: 'The number stays hidden until staff confirms. Please wait～',

      p_resultLab: 'This round\'s number',
      p_oePred: 'Odd/Even guess',
      p_numPred: 'Number guess',
      p_resultHint: 'Wait for staff to start a new round.',
      p_guessOE: 'Guessed "{x}" → {r}',
      p_hitYes: '✓ Hit',
      p_hitNo: '✗ Miss',

      p_welcome: 'Welcome back, {n}!',
      p_scanned: 'QR recognized {id}',
      p_manualEmpty: 'Enter QR content or ID',
      p_scanNetErr: 'Network error, try again',
      p_scanFail: 'Recognition failed',
      p_selOddEven: 'Choose "Odd" or "Even" first',
      p_selNum: 'Choose a number from 1-8',
      p_predSubmitting: 'Prediction submitted, waiting for draw!',
      p_predSubmitFail: 'Submit failed',
      p_logoutConfirm: 'Log out? This clears your local identity and requires re-scanning.',
      p_loggedOut: 'Logged out',

      p_err_bad_request: 'Malformed request',
      p_err_scan_empty: 'QR content is empty, please scan again',
      p_err_scan_too_long: 'QR content is too long (>{maxLen} characters) to register',
      p_err_scan_locked: 'This round has been drawn; new QR codes cannot enter. Please wait for staff to start a new round',
      p_err_predict_not_scanned: 'Please scan your QR code first',
      p_err_predict_closed: 'This round has been drawn; predictions are closed',
      p_err_predict_duplicate: 'You have already submitted a prediction and cannot resubmit or change it',
      p_err_predict_invalid_oe: 'Please choose "Odd" or "Even"',
      p_err_predict_invalid: 'Number prediction must be an integer from 1 to 8'
    }
  };

  // 预设语言列表（顺序即切换顺序），首项为默认语言
  var LOCALE_ORDER = ['zh-HK', 'zh-CN', 'en-US'];
  var DEFAULT_LOCALE = LOCALE_ORDER[0];
  var STORAGE_KEY = 'oe_i18n_locale';
  var current = null;

  function detectLocale() {
    var saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    if (saved && LOCALES[saved]) return saved;
    var nav = (global.navigator && (global.navigator.language || global.navigator.userLanguage)) || '';
    // 优先精确匹配，再退化为主语言前缀（如 zh-HK → zh）
    if (LOCALES[nav]) return nav;
    var main = nav.split('-')[0];
    for (var k in LOCALES) { if (k.indexOf(main) === 0) return k; }
    return DEFAULT_LOCALE;
  }

  /** 取当前语言包 */
  function messages() { return LOCALES[current]; }

  /** 格式化：将 {key} 占位符替换为实参 */
  function format(tpl, args) {
    if (!args) return tpl;
    return String(tpl).replace(/\{(\w+)\}/g, function (_, k) {
      return (k in args) ? String(args[k]) : '{' + k + '}';
    });
  }

  /**
   * 翻译主入口：t('key') 或 t('key', {round: 2, number: 5})
   * 缺 key 时返回 key 本身，避免界面出现 undefined。
   */
  function t(key, args) {
    var dict = messages();
    var val = dict[key];
    if (val == null) return key;
    return format(val, args);
  }

  /**
   * 初始化：可覆盖默认 storage key（工作人员端与玩家端各自独立记忆语言）。
   * 必须在页面渲染前调用。返回当前语言。
   */
  function init(opts) {
    opts = opts || {};
    if (opts.storageKey) STORAGE_KEY = opts.storageKey;
    current = detectLocale();
    document.documentElement.setAttribute('lang', current);
    return current;
  }

  function setLocale(loc) {
    if (!LOCALES[loc]) return false;
    current = loc;
    try { localStorage.setItem(STORAGE_KEY, loc); } catch (e) { /* ignore */ }
    var html = document.documentElement;
    html.setAttribute('lang', loc);
    // 触发自定义事件，供页面重新渲染动态文本
    html.dispatchEvent(new CustomEvent('locale-change', { detail: { locale: loc } }));
    return true;
  }

  function getLocale() { return current; }

  /** 返回「当前语言的下一个」语言（循环），供语言切换按钮调用 */
  function nextLocale() {
    var i = LOCALE_ORDER.indexOf(current);
    if (i < 0) return DEFAULT_LOCALE;
    return LOCALE_ORDER[(i + 1) % LOCALE_ORDER.length];
  }

  /**
   * 翻译服务端错误码：t('err_' + code, args)，可加前缀（如玩家端 'p_err_'）。
   * 服务端返回结构化 code（如 wrong_password / unauthorized），
   * 客户端按当前语言翻译；无对应文案时退回 code 本身。
   */
  function errCode(code, args, prefix) {
    var p = prefix || 'err_';
    if (!code) return t('errConfirmFailed');
    var val = messages()[p + code];
    if (val == null) return code;
    return format(val, args);
  }

  // 页面渲染前未显式 init 时，用默认 key 初始化
  current = detectLocale();
  document.documentElement.setAttribute('lang', current);

  global.I18N = {
    init: init,
    t: t,
    setLocale: setLocale,
    getLocale: getLocale,
    nextLocale: nextLocale,
    errCode: errCode
  };
})(window);
