/**
 * dsh-session-popout · 窗口管家（Window butler）
 *
 * 这是插件自己拉起的一个**独立 Electron 主进程**，唯一职责是管理我们所有的原生窗口：
 *   - 母级 = DSH 主窗口（不是它管的，它只管下面两种）
 *   - 大子级 = 会话集合窗口（一个窗口装多个会话，QQ 的合并窗口）
 *   - 子级 = 单会话窗口（一个窗口只装一个会话）
 *
 * 为什么是「一个进程管多个窗口」而不是「一个窗口一个进程」：
 *   1. Chromium 的单实例锁是按 userData 判的，一个窗口一个进程会互相踢；
 *   2. 合并/移出会话要能**实时**推给已经开着的窗口 —— 只有自己进程内的窗口，
 *      才能直接 executeJavaScript 改它的 hash，页面当场重排；
 *   3. 一个进程比 N 个进程省得多，且关掉一个窗口不会连带关掉别的。
 *
 * 宿主（插件 index.js）通过本进程在 127.0.0.1 上开的小 HTTP 口来指挥它。
 * 只监听回环地址，并且每个请求都要带一次性 token。
 */

const { app, BrowserWindow, nativeImage, nativeTheme, shell, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

const USER_DATA = argValue('--dsh-userdata');
const INFO_FILE = argValue('--dsh-info');
const TOKEN = argValue('--dsh-token');
/** DSH 的应用图标与资源目录，由宿主告诉我们 —— 不然任务栏上就是个光秃秃的 Electron。 */
const APP_ICON = argValue('--dsh-icon');
const DSK_THEME = argValue('--dsh-theme');
const STAMP = argValue('--dsh-stamp');
/** 子窗自己的 preload：补 DSH preload 那套窗口外观标记（无边框让位、拖拽区、圆角）。 */
const PRELOAD = path.join(__dirname, 'preload.cjs');

/** 最后一批窗口关掉后，等这么久再退出 —— 免得「关一个、马上开另一个」时反复重启。 */
const EXIT_GRACE_MS = 2500;
/** 启动了却一直没人要窗口，就自己退掉，别在后台挂着。 */
const IDLE_MS = 30000;
/** 默认开出来和母窗口一样大（母窗是 1280x820）——
 *  用户要的是「另一个 DSH 桌面窗口」，不是一个小竖条。 */
const CHILD_SIZE = { width: 1280, height: 820 };
const GROUP_SIZE = { width: 1280, height: 820 };
/** 最小尺寸沿用母窗口的 520x600，再小就不像桌面窗口了。 */
const MIN_WIDTH = 520;
const MIN_HEIGHT = 600;
/** 页面地址里标记角色的 hash 前缀，和 client.js 里那份必须一致。 */
const HASH_CHILD = '#dsh-popout=';
const HASH_GROUP = '#dsh-group=';

if (USER_DATA) {
  try {
    app.setPath('userData', USER_DATA);
    app.setPath('sessionData', USER_DATA);
  } catch {
    /* 设不了就用默认目录 */
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 只有一个管家；重复拉起时把最后活跃的窗口抬到前面即可。
    const last = [...windows.values()].filter((w) => w && !w.isDestroyed()).pop();
    if (last) {
      if (last.isMinimized()) last.restore();
      last.show();
      last.focus();
    }
  });
  app.whenReady().then(start);
}

/** key（`s:<sessionId>` 或 `g:<groupId>`）→ BrowserWindow */
const windows = new Map();
/** key → {kind, sessionId, groupId, base}。合并时要靠它知道这一窗是谁、能回到哪个地址。 */
const meta = new Map();
let server = null;
let exitTimer = null;
let idleTimer = null;
let appIcon = null;

/** groupId → 成员 sessionId 列表（顺序就是左侧标题栏的顺序）。 */
const groups = new Map();
let groupSeq = 0;

/** 把窗口标题条拖到另一个窗口上就合并 —— 判定用的高度与覆盖率。 */
const MERGE_STRIP_H = 46;
const MERGE_RATIO = 0.55;
/** 窗口被拖动时 move 会连发，停手这么久才算「放下了」。 */
/**
 * 拖停手多久才判「他想合进来」。
 *
 * 给 400ms 而不是一停就合：拖着一个窗口从别的窗口上掠过时，手会短暂停顿，
 * 停 100~200ms 很常见，400ms 的静止才算真的把它放在那儿了。
 */
const MOVE_SETTLE_MS = 400;
/** 自摆窗口后的静默期：程序把窗口放到位不算合并手势。 */
const SELF_MOVE_GUARD_MS = 700;

function newGroupId() {
  groupSeq += 1;
  return `g-${Date.now().toString(36)}-${groupSeq}`;
}

function groupOf(sessionId) {
  for (const [id, members] of groups) {
    if (members.includes(sessionId)) return id;
  }
  return '';
}

function membersOf(groupId) {
  return groups.get(groupId) || [];
}

function addToGroup(groupId, sessionId) {
  const members = membersOf(groupId).slice();
  if (sessionId && !members.includes(sessionId)) members.push(sessionId);
  groups.set(groupId, members);
  return members;
}

function removeFromGroup(groupId, sessionId) {
  const members = membersOf(groupId).filter((id) => id !== sessionId);
  if (members.length === 0) groups.delete(groupId);
  else groups.set(groupId, members);
  return members;
}

function hashForChild(sessionId) {
  return `${HASH_CHILD}${encodeURIComponent(sessionId)}`;
}

/**
 * 集合窗口的 hash 里直接带着成员和当前选中项。
 *
 * 成员是窗口管家保管的（合并来自「把一个窗口拖到另一个窗口上」，宿主根本不在场），
 * 所以让页面从 hash 读，比再绕一趟宿主简单，也不会出现两边状态打架。
 */
function hashForGroup(groupId, active) {
  const members = membersOf(groupId);
  const query = new URLSearchParams();
  query.set('s', members.join(','));
  if (active) query.set('a', active);
  return `${HASH_GROUP}${encodeURIComponent(groupId)}&${query.toString()}`;
}

function sessionOfKey(key) {
  return key.startsWith('s:') ? key.slice(2) : '';
}


/**
 * 一条 DSH 主窗口同款的「系统标题栏」。
 *
 * 主窗口用的是 titleBarStyle:"hidden" + titleBarOverlay（40px 原生按钮区），
 * 所以这里照抄：关掉系统标题栏、把最小化/最大化/关闭按钮画成原生浮层，
 * 页面再让出 40px。看起来就和母窗口是同一套窗口装饰。
 */
function titleBarFor() {
  // DSK_THEME 是宿主报上来的 DSH 偏好（light/dark），没有就跟随系统。
  // start() 里会把它设进 nativeTheme.themeSource，所以页面里的
  // prefers-color-scheme、DSH 的主题启动脚本和这里取的颜色三者是一致的。
  const dark = DSK_THEME === 'dark' ? true : DSK_THEME === 'light' ? false : nativeTheme.shouldUseDarkColors;
  // 与桌面壳的 chromeFallbackFill() 一致：暗色 #1b1b1c，亮色 #f9fafb。
  // 这是「没有更准确信息时」的兜底 —— DSH 的皮肤插件会在页面里改 body 背景，
  // 窗口打开后 preload 会把真实底色报上来（见 /dsh-popout:caption 通道），
  // 那时原生按钮区会跟着换成和页面一致的颜色。
  const color = dark ? '#1b1b1c' : '#f9fafb';
  const symbolColor = dark ? '#f9fafb' : '#0f1115';
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 40, color, symbolColor },
    backgroundColor: color,
    // Windows 的无边框窗口没有系统阴影时会显得不像一个窗口，补上。
    hasShadow: true,
  };
}

/* -------------------------------------------------------------------------- *
 * 窗口
 * -------------------------------------------------------------------------- */

function windowHashOf(targetUrl) {
  try {
    return new URL(targetUrl).hash || '';
  } catch {
    return '';
  }
}

function pushHash(win, hash) {
  if (!hash) return;
  const script = `try{if(location.hash!==${JSON.stringify(hash)}){location.hash=${JSON.stringify(
    hash,
  )};}}catch(e){}`;
  const run = () => win.webContents.executeJavaScript(script, true).catch(() => {});
  if (win.webContents.isLoading()) {
    // 页面还没就绪时 executeJavaScript 会失败，等它加载完再推一次。
    win.webContents.once('did-finish-load', run);
  } else {
    run();
  }
}

/** 页面报上来的标题栏配色，只用于 /health 自检，不参与渲染。 */
const captions = new Map();

/**
 * 窗口里页面自己报上来的自检信息，只用于 /health。
 *
 * 这个插件返工最多的一类问题都是「窗口看起来没变」，而原因可能在第 N 层：
 * hash 没传过来、preload 没跑、外壳没藏、前端 bundle 没加载、我们的界面没画出来。
 * 没有这份自检就只能靠猜。现在跑一次 /health 就能一眼看出坏在哪一层。
 */
const diagnostics = new Map();

/** 按 webContents 找回它所属的窗口 key。 */
function keyOfSender(sender) {
  for (const [key, win] of windows) {
    if (!win.isDestroyed() && win.webContents === sender) return key;
  }
  return '';
}

/**
 * 页面报上来的配色 → 刷原生标题栏按钮的颜色；同时收下自检信息。
 *
 * 主窗口的按钮颜色是 DSH 的 preload 盯着 body 变化发 IPC 换来的；
 * 子窗口没有那套东西，就用自己 preload 里的小通道补同样的效果。
 * 两个频道全局只注册一次，按发送者找回窗口，避免每开一个窗就挂一个监听。
 */
function installCaptionChannel() {
  const { ipcMain } = require('electron');

  /**
   * 同步身份查询：preload 在 document_start 就问「我是哪个窗口」。
   *
   * 为什么不用 webPreferences.additionalArguments：那是**进程级**的 process.argv。
   * 本插件所有窗口同源，Chromium 会把它们放进同一个渲染进程 —— 两个窗口的
   * argv 是同一份，后开的会把先开的角色覆盖掉。实测就是「子级报成 group、
   * 大子级报成 child」，两个窗口都渲染错。
   * ipcMain 的 event.sender 认的是 webContents，一个窗口一个，不会串。
   */
  ipcMain.on('dsh-popout:identity', (event) => {
    try {
      const key = keyOfSender(event.sender);
      const stamp = meta.get(key);
      event.returnValue = {
        role: stamp && (stamp.kind === 'group' || stamp.kind === 'child') ? stamp.kind : '',
        sessionId: (stamp && stamp.sessionId) || '',
        groupId: (stamp && stamp.groupId) || '',
      };
    } catch {
      event.returnValue = { role: '', sessionId: '', groupId: '' };
    }
  });

  ipcMain.on('dsh-popout:caption', (event, color, symbolColor) => {
    for (const win of windows.values()) {
      if (win.isDestroyed() || win.webContents !== event.sender) continue;
      try {
        win.setTitleBarOverlay({
          height: 40,
          color: String(color),
          symbolColor: String(symbolColor),
        });
        captions.set(win.id, { color: String(color), symbolColor: String(symbolColor) });
      } catch {
        /* 平台不支持就保持启动时的配色 */
      }
      return;
    }
  });

  ipcMain.on('dsh-popout:diag', (event, payload) => {
    try {
      const key = keyOfSender(event.sender);
      const record = { at: Date.now(), ...(payload && typeof payload === 'object' ? payload : {}) };
      if (key) diagnostics.set(key, record);
    } catch {
      /* 自检失败不该影响窗口 */
    }
  });
}

function clamp(value, low, high) {
  if (high < low) return low;
  return value < low ? low : value > high ? high : value;
}

/**
 * 把「鼠标松开的那一点」换算成窗口左上角。
 *
 * 用户是从侧栏把会话拖出来、在哪儿松手就在哪儿出窗，所以鼠标位置要落在
 * 窗口标题栏那一条上（跟 QQ 把聊天窗口丢在鼠标下方是一个意思）。
 * 越界就贴到显示器工作区边缘，别让窗口跑到屏幕外面去。
 */
/**
 * 窗口开在松手的位置上。
 *
 * 小窗时代是「鼠标点落在标题条左上角」；窗口和母窗一样大之后再这么做，
 * 1280 宽的窗口会从光标往右下铺开、直接出屏。所以改成让窗口中心
 * 落在光标的右下一点点 —— 松手的地方就在窗口中间偏左上，视线接得住。
 */
function placementFor(width, height, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  const area = display.workArea;
  const x = clamp(Math.round(point.x - width / 2), area.x, area.x + Math.max(0, area.width - width));
  const y = clamp(Math.round(point.y - 40), area.y, area.y + Math.max(0, area.height - height));
  return { x, y };
}

function createWindow(key, targetUrl, kind, options) {
  const opts = options || {};
  const area = screen.getPrimaryDisplay().workAreaSize;
  const isGroup = kind === 'group';
  const wanted = isGroup ? GROUP_SIZE : CHILD_SIZE;
  const width = Math.min(opts.width || wanted.width, Math.max(320, area.width - 80));
  const height = Math.min(opts.height || wanted.height, Math.max(420, area.height - 100));
  const placed = placementFor(width, height, opts.point);

  const win = new BrowserWindow({
    width,
    height,
    ...(placed ? { x: placed.x, y: placed.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: isGroup ? '会话集合 · DSH' : 'DSH 小窗',
    show: false,
    autoHideMenuBar: true,
    ...titleBarFor(),
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // ★ 角色由这里直接告诉 preload，不让它去猜 URL hash。
      //
      // 之前 preload 和 client.js 都是读 location.hash 判角色的。hash 这一路
      // 只要有一环不对（launch token 的 303 跳转、SPA 自己改地址、管家复用窗口
      // 时 hash 推晚了），页面就把自己当成母级 —— 于是外壳一条都不藏，整窗
      // 就是完整的 DSH 界面。用户看到的「压根没变」就是这个。
      // 主进程在建窗时就明确知道自己开的是单窗还是集合窗，直接传下去最可靠。
      additionalArguments: [
        `--dsh-popout-role=${kind === 'group' ? 'group' : 'child'}`,
        // 会话 / 集合 id 也一起传下去：hash 万一没到（303 跳转、SPA 改地址、
        // 推晚了），页面还能从建窗参数里拿到该显示什么，不会开出一个空白窗。
        ...(opts.sessionId ? [`--dsh-popout-session=${opts.sessionId}`] : []),
        ...(opts.groupId ? [`--dsh-popout-group=${opts.groupId}`] : []),
      ],
    },
  });

  win.setMenuBarVisibility(false);

  // 页面一出生就把 DSH 外壳藏掉。
  //
  // preload 也会做同一件事，但它打在「文档创建后」；而 DSH 的外壳是前端
  // bundle 一挂载就画出来的，中间可能空出一两帧完整母级。这里在 dom-ready
  // 再补一次（那时 documentElement 一定在，executeJavaScript 不会因文档
  // 还没建好而失败）。
  //
  // 用 <html> 上的标记而不是隐藏具体节点：选择器靠 data-shell-overlay 反查
  // 外壳那一层，不认构建哈希类名（理由见 preload.cjs 的 CSS 注释）。
  try {
    const role = kind === 'group' ? 'group' : 'child';
    win.webContents.on('dom-ready', () => {
      win.webContents
        .executeJavaScript(
          `(() => { try { const r = document.documentElement; r.dataset.dshPopout = ''; r.dataset.dshPopoutRole = ${JSON.stringify(role)}; } catch {} })()`,
          true,
        )
        .catch(() => {});
    });
  } catch {
    /* 注入失败最多是外壳闪一下，不影响功能 */
  }

  // 页面里的 window.open / 外链一律不在本窗口里开。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 只允许留在自己的 origin 和 dsh-app 协议里，别的一律外抛。
  win.webContents.on('will-navigate', (event, url) => {
    let ok = false;
    try {
      const target = new URL(url);
      const own = new URL(targetUrl);
      ok = target.origin === own.origin || target.protocol === 'dsh-app:';
    } catch {
      ok = false;
    }
    if (!ok) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 标题跟着会话名走，任务栏上一眼能认出来。
  win.webContents.on('page-title-updated', (event, title) => {
    if (!title || !title.trim()) {
      event.preventDefault();
      return;
    }
    win.setTitle(title.trim());
  });

  win.once('ready-to-show', () => win.show());

  /*
   * 页面在自己身上换会话（子窗顶部的下拉框切到同项目另一个会话）时，
   * 窗口地址里的 hash 变了，管家的成员记录却还停在旧会话上 ——
   * 之后拿这个窗口去合并，合进去的就是那个早就不在显示的会话。
   * 所以这里跟着 hash 把 meta.sessionId 修回去。
   */
  win.webContents.on('did-navigate-in-page', () => {
    try {
      for (const [entryKey, entryWin] of windows) {
        if (entryWin !== win) continue;
        const entry = meta.get(entryKey);
        if (!entry || entry.kind !== 'child') return;
        const raw = windowHashOf(win.webContents.getURL());
        if (!raw.startsWith(HASH_CHILD)) return;
        const next = decodeURIComponent(raw.slice(HASH_CHILD.length));
        if (!next || next === entry.sessionId) return;
        meta.set(entryKey, { ...entry, sessionId: next });
      }
    } catch {
      /* 地址取不到就当没换过 */
    }
  });

  win.on('closed', () => {
    // 合并会把这个窗口换个 key 活着（s:… → g:…），所以不能只按建窗时的 key 删，
    // 否则 map 里会留一个指向已销毁窗口的死条目。
    for (const [entryKey, entryWin] of windows) {
      if (entryWin === win) {
        windows.delete(entryKey);
        meta.delete(entryKey);
      }
    }
    captions.delete(win.id);
    if (moveTimers.has(win.id)) {
      clearTimeout(moveTimers.get(win.id));
      moveTimers.delete(win.id);
    }
    scheduleExit();
  });

  windows.set(key, win);
  meta.set(key, {
    kind,
    sessionId: opts.sessionId || sessionOfKey(key),
    groupId: opts.groupId || '',
    // 干净的首页地址：窗口地址随时要重新拼（换 hash 就够了，不必再走一趟 launch token）。
    base: opts.base || `${new URL(targetUrl).origin}/`,
    noMergeAt: Date.now() + SELF_MOVE_GUARD_MS,
  });
  installMergeWatch(key, win);
  cancelExit();

  win.loadURL(targetUrl).catch((err) => {
    console.error(`dsh-session-popout: load failed: ${err.message}`);
    if (!win.isDestroyed()) win.destroy();
  });

  return win;
}

/* -------------------------------------------------------------------------- *
 * 拖到另一个窗口上就合并
 * -------------------------------------------------------------------------- */

/** win.id → 停手判定的定时器。窗口一直动就一直重置。 */
const moveTimers = new Map();

function titleStripOf(win) {
  const box = win.getBounds();
  return { x: box.x, y: box.y, width: box.width, height: Math.min(MERGE_STRIP_H, box.height) };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 找另一个「标题条压上去」比阈值还多的窗口；没有就返回 null。 */
function findMergeTarget(selfKey, selfWin) {
  const strip = titleStripOf(selfWin);
  let best = null;
  let bestRatio = 0;
  for (const [key, win] of windows) {
    if (key === selfKey || win.isDestroyed() || !win.isVisible()) continue;
    const ratio = overlapArea(strip, titleStripOf(win)) / (strip.width * strip.height || 1);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = { key, win };
    }
  }
  return bestRatio >= MERGE_RATIO ? best : null;
}

/**
 * 把一个窗口并进另一个。
 *
 * 四种组合都要处理，否则用户会看到同一个会话两份：
 *   子级 → 子级   两边都是单会话，合成一个新的集合窗口，两个单窗都收掉；
 *   子级 → 集合   单会话并进去，单窗收掉；
 *   集合 → 集合   成员合并，被拖的那个集合窗收掉；
 *   集合 → 子级   等价于「子级 → 集合」，以被压住的那个会话为集合的第二成员。
 */
function mergeWindows(selfKey, targetKey) {
  const selfMeta = meta.get(selfKey);
  const targetMeta = meta.get(targetKey);
  const selfWin = windows.get(selfKey);
  const targetWin = windows.get(targetKey);
  if (!selfMeta || !targetMeta || !selfWin || !targetWin) return null;
  if (selfWin.isDestroyed() || targetWin.isDestroyed()) return null;

  // 集合窗口只能有一个：两个集合相遇时，把小的并进大的，省得来回搬成员。
  let hostKey = targetKey;
  let donorKey = selfKey;
  let hostMeta = targetMeta;
  let donorMeta = selfMeta;
  if (selfMeta.kind === 'group' && targetMeta.kind === 'group') {
    const selfCount = membersOf(selfMeta.groupId).length;
    const targetCount = membersOf(targetMeta.groupId).length;
    if (selfCount > targetCount) {
      hostKey = selfKey;
      donorKey = targetKey;
      hostMeta = selfMeta;
      donorMeta = targetMeta;
    }
  }

  let groupId = hostMeta.kind === 'group' ? hostMeta.groupId : '';
  if (!groupId) {
    groupId = newGroupId();
    groups.set(groupId, []);
    if (hostMeta.kind === 'child') addToGroup(groupId, hostMeta.sessionId);
  }

  if (donorMeta.kind === 'group') {
    for (const sessionId of membersOf(donorMeta.groupId)) addToGroup(groupId, sessionId);
    groups.delete(donorMeta.groupId);
  } else {
    addToGroup(groupId, donorMeta.sessionId);
  }

  const active = donorMeta.kind === 'child' ? donorMeta.sessionId : membersOf(groupId)[0];
  const hostWin = windows.get(hostKey);
  const hostBase = hostMeta.base;

  // 被压住的那个窗口原地变成集合窗口 —— 用户是把它当「接收方」的，别让它跳走。
  windows.delete(hostKey);
  meta.delete(hostKey);
  const newKey = `g:${groupId}`;
  windows.set(newKey, hostWin);
  meta.set(newKey, { kind: 'group', sessionId: '', groupId, base: hostBase });
  pushHash(hostWin, hashForGroup(groupId, active));
  // 单窗升级成集合窗后最小尺寸不变（两边现在都是母窗口的下限）。
  try {
    hostWin.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
  } catch {
    /* 设不上就算了 */
  }
  if (hostWin.isMinimized()) hostWin.restore();
  hostWin.show();
  hostWin.focus();

  const donorWin = windows.get(donorKey);
  windows.delete(donorKey);
  meta.delete(donorKey);
  if (donorWin && !donorWin.isDestroyed()) donorWin.close();

  return { groupId, members: membersOf(groupId), active };
}

/**
 * 盯住窗口的移动：停手后看它的标题条压在谁身上。
 *
 * 用 move + 停手计时而不是原生拖拽，是因为跨窗口的原生拖放到了 Windows 上
 * 拿不到可靠的落点（dragover 在别的窗口里根本不来），而窗口坐标永远是准的。
 */
function installMergeWatch(key, win) {
  win.on('move', () => {
    const id = win.id;
    if (moveTimers.has(id)) clearTimeout(moveTimers.get(id));
    moveTimers.set(
      id,
      setTimeout(() => {
        moveTimers.delete(id);
        try {
          if (win.isDestroyed() || win.isMinimized()) return;
          const currentKey = [...windows.entries()].find(([, w]) => w === win)?.[0] || key;
          // 程序自己摆窗口（刚开出来、刚从集合里拆出来）也会触发 move，
          // 那不是用户在拖，不该被当成一次合并手势。
          const stamp = meta.get(currentKey);
          if (stamp && Number.isFinite(stamp.noMergeAt) && Date.now() < stamp.noMergeAt) return;
          const target = findMergeTarget(currentKey, win);
          if (!target) {
            // 停手了但没压到谁家标题上，是正常手感，只留一条可排查的痕迹。
            console.log(
              `dsh-session-popout: settle ${currentKey} at ${JSON.stringify(win.getBounds())} → no target (windows: ${[
                ...windows.keys(),
              ].join(',')})`,
            );
            return;
          }
          mergeWindows(currentKey, target.key);
        } catch (err) {
          console.error(`dsh-session-popout: merge failed: ${err && err.message}`);
        }
      }, MOVE_SETTLE_MS),
    );
  });
}

/**
 * 开窗（或复用）。返回 { win, reused }。
 *
 * 新建时 options.point 决定窗口落在鼠标松手的地方；复用时不挪窝 ——
 * 用户已经在用一个窗口了，把它从屏幕那头拽过来只会打断他。
 */
function openWindow(key, targetUrl, kind, options) {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    pushHash(existing, windowHashOf(targetUrl));
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { win: existing, reused: true };
  }
  return { win: createWindow(key, targetUrl, kind, options), reused: false };
}

function scheduleExit() {
  if (exitTimer) return;
  exitTimer = setTimeout(() => {
    exitTimer = null;
    if (windows.size === 0) quitNow();
  }, EXIT_GRACE_MS);
}

function cancelExit() {
  if (exitTimer) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
}

function quitNow() {
  try {
    if (INFO_FILE) fs.rmSync(INFO_FILE, { force: true });
  } catch {
    /* 删不掉也不影响退出 */
  }
  app.quit();
}

/* -------------------------------------------------------------------------- *
 * 指挥口
 * -------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function handle(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (TOKEN && url.searchParams.get('token') !== TOKEN) {
      sendJson(res, 403, { ok: false, error: 'bad-token' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    switch (url.pathname) {
      case '/health':
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          // title 一起报出来，排查时能确认页面真的加载了、主题也认得出会话。
          windows: [...windows.entries()].map(([key, win]) => ({
            key,
            title: win.isDestroyed() ? '' : win.webContents.getTitle(),
            url: win.isDestroyed() ? '' : win.webContents.getURL(),
            caption: win.isDestroyed() ? null : captions.get(win.id) || null,
            bounds: win.isDestroyed() ? null : win.getBounds(),
            // 页面自己报上来的自检：外壳藏没藏、我们的界面画没画、认成什么角色。
            diag: diagnostics.get(key) || null,
            ...(meta.get(key) || {}),
          })),
          groups: [...groups.entries()].map(([groupId, members]) => ({ groupId, members })),
        });
        return;
      case '/open': {
        const key = url.searchParams.get('key') || '';
        const target = url.searchParams.get('url') || '';
        const kind = url.searchParams.get('kind') === 'group' ? 'group' : 'child';
        if (!key || !target) {
          sendJson(res, 400, { ok: false, error: 'missing-args' });
          return;
        }
        // 拖到哪儿就在哪儿开：页面把松手那一刻的屏幕坐标一起报上来。
        // 页面报不上来时（拖出窗口边界后 dragend 的坐标可能是 0），
        // 直接问系统光标 —— 松手那一瞬鼠标就在落点上，这是最准的一份。
        let point = null;
        const px = Number(url.searchParams.get('x'));
        const py = Number(url.searchParams.get('y'));
        if (Number.isFinite(px) && Number.isFinite(py) && (px !== 0 || py !== 0)) {
          point = { x: px, y: py };
        } else {
          try {
            const cursor = screen.getCursorScreenPoint();
            if (Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) point = cursor;
          } catch {
            point = null;
          }
        }
        const sessionId = url.searchParams.get('sessionId') || sessionOfKey(key);
        const groupId = url.searchParams.get('groupId') || '';
        if (kind === 'group' && groupId) {
          if (!groups.has(groupId)) groups.set(groupId, []);
          // 宿主明确说「把这个会话放进这个集合」，那就放进去 —— 拖窗口合并是另一条路，
          // 两条路都落到同一份成员表上。
          if (sessionId) addToGroup(groupId, sessionId);
        }
        const existing = windows.get(key);
        const reused = Boolean(existing && !existing.isDestroyed());
        const { win } = openWindow(key, target, kind, { point, sessionId, groupId });
        if (kind === 'group' && groupId && win && !win.isDestroyed()) {
          // 成员表在管家手里，hash 由管家重新拼一遍，页面就不会拿到过期的成员。
          pushHash(win, hashForGroup(groupId, sessionId || membersOf(groupId)[0]));
        }
        sendJson(res, 200, { ok: true, reused, key, groupId, members: groupId ? membersOf(groupId) : [] });
        return;
      }
      case '/group': {
        const groupId = url.searchParams.get('groupId') || '';
        sendJson(res, 200, { ok: true, groupId, members: membersOf(groupId) });
        return;
      }
      case '/select': {
        // 集合窗口左侧点标题：把选中项写进 hash，页面收到 hashchange 自己换。
        const groupId = url.searchParams.get('groupId') || '';
        const sessionId = url.searchParams.get('sessionId') || '';
        const win = windows.get(`g:${groupId}`);
        if (!win || win.isDestroyed() || !membersOf(groupId).includes(sessionId)) {
          sendJson(res, 200, { ok: false, error: 'no-such-window-or-member' });
          return;
        }
        pushHash(win, hashForGroup(groupId, sessionId));
        sendJson(res, 200, { ok: true });
        return;
      }
      case '/unmerge': {
        // 把会话从集合里拆出来，重新变成它自己的小窗。
        const groupId = url.searchParams.get('groupId') || '';
        const sessionId = url.searchParams.get('sessionId') || '';
        const groupWin = windows.get(`g:${groupId}`);
        // 集合窗自己知道干净的首页地址，页面忘了带 base 也拆得出去。
        const groupMeta = meta.get(`g:${groupId}`);
        const base = url.searchParams.get('base') || (groupMeta ? groupMeta.base : '');
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: 'missing-args' });
          return;
        }
        const members = removeFromGroup(groupId, sessionId);
        const empties = members.length === 0;

        const childKey = `s:${sessionId}`;
        const existingChild = windows.get(childKey);
        if (!existingChild || existingChild.isDestroyed()) {
          if (!base) {
            sendJson(res, 400, { ok: false, error: 'missing-base' });
            return;
          }
          // 拆出来的窗口就落在集合窗的位置上，用户视线不用挪。
          const anchor = groupWin && !groupWin.isDestroyed() ? groupWin.getBounds() : null;
          openWindow(childKey, `${base}${hashForChild(sessionId)}`, 'child', {
            sessionId,
            base,
            point: anchor ? { x: anchor.x + 48, y: anchor.y + 48 } : null,
          });
        } else {
          existingChild.show();
          existingChild.focus();
        }

        if (groupWin && !groupWin.isDestroyed()) {
          if (empties) {
            const key = `g:${groupId}`;
            windows.delete(key);
            meta.delete(key);
            groupWin.close();
          } else {
            pushHash(groupWin, hashForGroup(groupId, members[0]));
          }
        }

        sendJson(res, 200, { ok: true, members, emptied: empties });
        return;
      }
      case '/close': {
        const key = url.searchParams.get('key') || '';
        const win = windows.get(key);
        if (win && !win.isDestroyed()) win.close();
        sendJson(res, 200, { ok: true });
        return;
      }
      case '/shutdown': {
        // 宿主发现管家跑的是旧代码时会走这里，让旧进程自己退干净，
        // 下一个窗口就会用新代码重新起一个。
        sendJson(res, 200, { ok: true });
        quitNow();
        return;
      }
      case '/focus': {
        const key = url.searchParams.get('key') || '';
        const win = windows.get(key);
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        sendJson(res, 200, { ok: Boolean(win && !win.isDestroyed()) });
        return;
      }
      case '/move': {
        // 挪窗口。给自检用：合并是靠「窗口标题条压到另一个窗口上」触发的，
        // 而从外面没法可靠地模拟一次原生拖动，所以留一个能直接把窗口摆过去的入口。
        const key = url.searchParams.get('key') || '';
        const win = windows.get(key);
        if (!win || win.isDestroyed()) {
          sendJson(res, 200, { ok: false, error: 'no-such-window' });
          return;
        }
        const x = Number(url.searchParams.get('x'));
        const y = Number(url.searchParams.get('y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          sendJson(res, 400, { ok: false, error: 'missing-args' });
          return;
        }
        const box = win.getBounds();
        win.setBounds({ x: Math.round(x), y: Math.round(y), width: box.width, height: box.height });
        sendJson(res, 200, { ok: true, bounds: win.getBounds() });
        return;
      }
      default:
        sendJson(res, 404, { ok: false, error: 'not-found' });
    }
  } catch (err) {
    sendJson(res, 500, { ok: false, error: 'internal-error', message: err && err.message });
  }
}

function start() {
  // Windows 上任务栏图标按 AppUserModelID 分组；不设的话子窗会和 Electron 归一类，
  // 而不是跟 DSH 挤在一起 —— 那两个 AppUserModelID 都试一遍。
  try {
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek.dsh');
  } catch {
    /* 设不上只是任务栏分组不同 */
  }
  // 任务栏上显示成 DSH，而不是「Electron」。
  try {
    app.setName('DeepSeek Harness');
  } catch {
    /* 名字设不上也不影响窗口 */
  }
  // 子窗跟随 DSH 当前的深浅色，不跟随系统 —— 否则母窗深色、子窗浅色，一眼两个程序。
  try {
    if (DSK_THEME === 'dark' || DSK_THEME === 'light') {
      nativeTheme.themeSource = DSK_THEME;
    }
  } catch {
    /* 主题设不上就用系统默认 */
  }
  if (APP_ICON) {
    try {
      const img = nativeImage.createFromPath(APP_ICON);
      if (!img.isEmpty()) appIcon = img;
    } catch {
      /* 图标读不到就退回 Electron 默认图标 */
    }
  }

  installCaptionChannel();

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (windows.size === 0) quitNow();
  }, IDLE_MS);

  server = http.createServer(handle);
  server.on('error', (err) => {
    console.error(`dsh-session-popout butler: listen failed: ${err.message}`);
    app.quit();
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    if (INFO_FILE) {
      try {
        fs.mkdirSync(path.dirname(INFO_FILE), { recursive: true });
        fs.writeFileSync(
          INFO_FILE,
          JSON.stringify({ port, pid: process.pid, startedAt: Date.now(), stamp: STAMP }),
        );
      } catch (err) {
        console.error(`dsh-session-popout butler: info write failed: ${err.message}`);
      }
    }
    console.log(`dsh-session-popout butler ready on 127.0.0.1:${port}`);
  });
}

// 窗口全关了不等于要立刻死：等一下可能还有新窗口要开。
app.on('window-all-closed', () => scheduleExit());

app.on('will-quit', () => {
  try {
    if (INFO_FILE) fs.rmSync(INFO_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  try {
    if (server) server.close();
  } catch {
    /* 忽略 */
  }
});
