/**
 * dsh-session-popout · 子窗口的 preload
 *
 * 这个文件负责四件事，顺序很重要：
 *
 *   1. 把「我是谁」认出来，通过 identity 桥交给页面。不能只等页面里的 client.js
 *      自己读 location.hash —— 它要等一串模块加载完才跑，那之前 DSH 的完整
 *      界面已经画出来了。
 *
 *   2. 把 DSH 自己的外壳（侧栏、新会话按钮、工作区、右栏、底部条）藏掉。
 *      隐藏规则用 webFrame.insertCSS 在文档创建时就注入，**不依赖 client.js**。
 *      原先这条规则只写在 client.js 的 CSS 常量里，只要那一侧没跑起来就一条
 *      规则都不生效，窗口就露出完整的母级 —— 用户说的「压根没变」就是这个。
 *
 *   3. 补 DSH preload 那套窗口外观标记（无边框让位、拖拽区），并提供一个
 *      caption 通道让右上角按钮的配色跟着主题走。
 *
 *   4. 把窗口里实际发生了什么报给主进程（/health 里能看到），供排错。
 *
 * ★ 绝不能打 `data-platform` —— 这是踩过的坑，代价是整窗白屏：
 *   `@deepseek-ai/dsh-client-shortcuts` 用
 *   `document.documentElement.dataset.platform` 是否存在来判定「是不是桌面端」
 *   （见它内部的 detectEnvironment）。一旦存在，它就认定 runtime = "desktop"，
 *   随后强制要求 `window.dshDesktop.keyboard` 这个原生键盘桥存在，否则直接
 *     throw new Error("Desktop keyboard bridge unavailable")
 *   那个桥只有官方 preload 才提供，我们的子窗没有。结果就是子窗里整个
 *   Client 插件图（30 个 entry）全部 "Failed to load plugins"。
 *
 *   ⇒ 子窗只打 `data-windows-titlebar`（它单独就能让内容让出 40px 顶栏，
 *     见 layout 的 `html[data-windows-titlebar]{--dsh-frame-top-clearance:…}`），
 *     **不打 `data-platform`**。这样 shortcuts 按 web 运行时走 localStorage
 *     适配器，不需要任何原生桥；平台判断退回 navigator.platform（Windows 上
 *     是 "Win32"，同样判成 windows），快捷键行为不变。
 *     DSH 自身的 CSS 里没有任何 `[data-platform=windows]` 选择器，
 *     只有 `[data-platform=darwin]` 和 `html:not([data-platform=darwin])`，
 *     后者在 Windows 上本来就是期望命中的那一支 —— 不打标记正好。
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const TITLEBAR_HEIGHT = 40;

/** 和 client.js / main.cjs 里那两份必须一致。 */
const HASH_CHILD = '#dsh-popout=';
const HASH_GROUP = '#dsh-group=';

/**
 * 建窗时主进程想告诉我们的身份。
 *
 * ★ 这两个 argv 变量只当**兜底**用，不能当主来源：
 *   本插件所有窗口同源，Chromium 会把它们塞进同一个渲染进程，于是
 *   `process.argv` 是进程级共享的 —— 后开的窗口会覆盖先开的窗口的角色。
 *   实测过：开一子一集，子级报成 group、大子级报成 child。真正可靠的是
 *   `askMain()` 那条同步 IPC（ipcMain 的 event.sender 认 webContents，
 *   一个窗口一个，不会串）。
 */
const ROLE_ARG = '--dsh-popout-role=';
const SESSION_ARG = '--dsh-popout-session=';
const GROUP_ARG = '--dsh-popout-group=';

function argOf(name) {
  try {
    const hit = process.argv.find((item) => item.startsWith(name));
    return hit ? hit.slice(name.length) : '';
  } catch {
    return '';
  }
}

const ARG_ROLE = (() => {
  const value = argOf(ROLE_ARG);
  return value === 'child' || value === 'group' ? value : '';
})();
const ARG_SESSION = argOf(SESSION_ARG);
const ARG_GROUP = argOf(GROUP_ARG);

/**
 * 向主进程同步问「我是哪个窗口」。
 *
 * `ipcRenderer.sendSync` 在 preload 里可以同步拿到结果，正好够早 ——
 * 页面脚本还没跑、外壳还没画出来。主进程按 event.sender 查它自己的
 * windows/meta 表，天然按窗口隔离。
 *
 * 返回 `{role, sessionId, groupId}`；问不到就全空，让调用方退回 argv/hash。
 */
function askMain() {
  try {
    const answer = ipcRenderer.sendSync('dsh-popout:identity');
    if (!answer || typeof answer !== 'object') return null;
    if (answer.role !== 'child' && answer.role !== 'group') return null;
    return {
      role: answer.role,
      sessionId: typeof answer.sessionId === 'string' ? answer.sessionId : '',
      groupId: typeof answer.groupId === 'string' ? answer.groupId : '',
    };
  } catch {
    return null;
  }
}

const MAIN_IDENTITY = askMain();

/** 角色：主进程答的 > argv 兜底 > ''。 */
const INJECTED_ROLE = (MAIN_IDENTITY && MAIN_IDENTITY.role) || ARG_ROLE;
const INJECTED_SESSION = (MAIN_IDENTITY && MAIN_IDENTITY.sessionId) || ARG_SESSION;
const INJECTED_GROUP = (MAIN_IDENTITY && MAIN_IDENTITY.groupId) || ARG_GROUP;

/**
 * 从 location.hash 认出这个窗口要显示什么。
 *
 * 集合窗口的成员表由窗口管家保管（合并是拖窗口标题条完成的，宿主不在场），
 * 管家改完成员会把新成员拼进 hash 推过来，所以这里直接读得到。
 *
 * hash 只负责「显示哪个会话 / 哪几个成员」，不负责「我是不是弹窗」——
 * 后者由 INJECTED_ROLE 定，见上。
 */
function parseIdentity() {
  const none = { role: 'parent', sessionId: '', groupId: '', members: [], active: '' };
  try {
    const hash = String(window.location.hash || '');
    if (hash.startsWith(HASH_CHILD)) {
      return {
        ...none,
        role: 'child',
        sessionId: decodeURIComponent(hash.slice(HASH_CHILD.length)),
      };
    }
    if (hash.startsWith(HASH_GROUP)) {
      const rest = hash.slice(HASH_GROUP.length);
      const cut = rest.indexOf('&');
      const rawId = cut === -1 ? rest : rest.slice(0, cut);
      const params = new URLSearchParams(cut === -1 ? '' : rest.slice(cut + 1));
      const list = (params.get('s') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      return {
        role: 'group',
        sessionId: '',
        groupId: decodeURIComponent(rawId),
        members: list,
        active: (params.get('a') || '').trim(),
      };
    }
    // hash 还没到位，但主进程已经说了这是弹窗：先按注入的角色报上去，
    // 让页面至少不会把自己渲染成母级（外壳照样藏，我们的界面等 hash 到了再画）。
    const injected = effectiveRole();
    if (injected) {
      return {
        ...none,
        role: injected,
        // 建窗时就定死的会话 / 集合，补上 hash 缺的那一份内容。
        sessionId: injected === 'child' ? INJECTED_SESSION : '',
        groupId: injected === 'group' ? INJECTED_GROUP : '',
        members: injected === 'group' && INJECTED_SESSION ? [INJECTED_SESSION] : [],
        active: injected === 'group' ? INJECTED_SESSION : '',
      };
    }
    return none;
  } catch {
    const injected = effectiveRole();
    if (!injected) return none;
    return {
      ...none,
      role: injected,
      sessionId: injected === 'child' ? INJECTED_SESSION : '',
      groupId: injected === 'group' ? INJECTED_GROUP : '',
      members: injected === 'group' && INJECTED_SESSION ? [INJECTED_SESSION] : [],
      active: injected === 'group' ? INJECTED_SESSION : '',
    };
  }
}

/** 这个窗口是不是插件自己开的弹窗（单窗或集合窗都算）。 */
function isPopout() {
  if (effectiveRole()) return true;
  return parseIdentity().role !== 'parent';
}

/**
 * 角色，三个来源依次退让：
 *   1. 建窗时主进程传下来的 `--dsh-popout-role=`（最可靠，进程一出生就有）；
 *   2. <html> 上的 data-dsh-popout-role（主进程 dom-ready 时补写，供页面脚本读）；
 *   3. 什么都不知道 → 空（此时才去看 hash）。
 */
function effectiveRole() {
  if (INJECTED_ROLE) return INJECTED_ROLE;
  try {
    const value = document.documentElement && document.documentElement.dataset
      ? document.documentElement.dataset.dshPopoutRole
      : '';
    return value === 'child' || value === 'group' ? value : '';
  } catch {
    return '';
  }
}

/**
 * 藏掉 DSH 外壳的规则。
 *
 * 为什么用 :has() 反查、而不是写死 `.BynINW_sidebarCol` 这种类名：
 * 那些类名带构建哈希，DSH 一升级就全变；而 `data-shell-overlay` 是布局层
 * 给的稳定标记（AppFrame 里那层浮动容器）。规则含义是：
 *   「任何直接含有浮层容器的元素」＝ 外壳框架本身；
 *   框架里除浮层以外的所有兄弟（侧栏列、中列、右栏、底部条、leading 位）
 *   统统隐藏，只留浮层 —— 我们的界面就画在浮层里。
 *
 * 另外把 body 的滚动也一并锁住：外壳被隐藏后框架仍然占着整个视口高度，
 * 不锁的话会多出一条滚动条。
 */
const HIDE_SHELL_CSS = `
/* 1) 把外壳收成「只剩中间那一列」。

   曾经这里写的是「框架里除浮层以外的兄弟一律 display:none」—— 那是给旧版
   （自己在浮层里画一整套对话界面）用的。现在对话由宿主自己渲染，而绘制它的
   那一列正是框架的兄弟之一：那条规则会把整个会话界面一起藏掉，用户看到的就是
   一张壁纸。用户截图里「只有壁纸」就是这么来的。

   也不能改成「藏掉侧栏那一列」：这些列是 grid 子项，藏掉其中一个会让后面的列
   顶到前面去，整个布局错位。改列宽才是安全的做法：侧栏 0、中间吃满、右栏 0。

   只在外壳自己已经标记「侧栏收起」时才补这一刀 —— 正常情况下宿主的布局状态
   已经把列宽算成 0/1fr/0 了，这里只是防止别的样式再把它撑开。用属性当条件而不是
   无条件强制，是为了不给「用户手动展开侧栏」这类合法状态添乱。 */
html[data-dsh-popout] body *:has(> [data-shell-overlay])[data-sidebar-collapsed] {
  grid-template-columns: 0 minmax(0px, 1fr) minmax(0px, 0px) !important;
}

/* 2) 浮层里还住着宿主自己的弹窗（预览版说明、额度提示、版本更新提示、toast）
   和别的插件挂的浮块（dsh-pet 1000、dsh-wb-balance 900）。它们会和我们的
   状态提示并排出现，压在界面上面。这里只放行带 data-dsp-keep 的条目 ——
   那是本插件自己的提示，其余全不显示。
   client.js 里有一份同样的规则，两处都留着：这份来得更早，能挡住启动那一瞬的
   闪烁；那份在热重载时也能兜底。 */
html[data-dsh-popout] [data-shell-overlay] > *:not([data-dsp-keep]):not(:has([data-dsp-keep])) {
  display: none !important;
}

html[data-dsh-popout] body {
  overflow: hidden;
}
html[data-dsh-popout],
html[data-dsh-popout] body {
  background: var(--dsw-alias-bg-base, #ffffff);
}
`;

let shellCssInstalled = false;

/** 给 <html> 打标记并注入隐藏规则。可以重复调用（幂等）。 */
function markPopoutFrame() {
  try {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.dshPopout = '';
    // 角色也挂一份在 <html> 上：页面脚本（client.js）可能比 preload 的桥调用
    // 更早，或者桥没暴露成功；从属性读是不依赖任何 API 的兜底。
    const role = effectiveRole();
    if (role) root.dataset.dshPopoutRole = role;
    // 内容也挂一份：hash 万一没到，client.js 从这里也能拿到要显示哪个会话。
    if (role === 'child' && INJECTED_SESSION) root.dataset.dshPopoutSession = INJECTED_SESSION;
    if (role === 'group' && INJECTED_GROUP) root.dataset.dshPopoutGroup = INJECTED_GROUP;
    if (!shellCssInstalled) {
      shellCssInstalled = true;
      try {
        webFrame.insertCSS(HIDE_SHELL_CSS);
      } catch {
        /* 注入不了就先靠 client.js 里那份同样的规则兜底 */
      }
    }
    return true;
  } catch {
    /* 打不上标记最多是外壳露出来，不影响对话本身 */
    return false;
  }
}

/**
 * 与 DSH preload 的 syncWindowsAppearance 一致：打标记 + 写高度变量。
 *
 * 只打 `data-windows-titlebar`，**绝不打 `data-platform`** —— 原因见文件头。
 */
function markWindowsFrame() {
  try {
    const root = document.documentElement;
    if (!root) return;
    if (process.platform !== 'win32') return;
    root.dataset.windowsTitlebar = '';
    root.style.setProperty('--dsh-windows-titlebar-height', `${TITLEBAR_HEIGHT}px`);
  } catch {
    /* 标记打不上最多是外观不对，不该影响页面本身 */
  }
}

/**
 * 尽最大可能早地把标记挂上。
 *
 * preload 执行时 document 在，但 <html> 往往还没被解析器插进来
 * （documentElement 为 null）—— 实测等到 DOMContentLoaded 才补，
 * 页面自己的脚本已经先跑过了，中间那几帧就是一个完整的母级。
 *
 * 所以这里对 document 挂一次 childList 观察：解析器一插入 <html>
 * 就立刻（微任务，早于页面脚本）打标记，打完自己摘掉。
 */
function markAsap() {
  if (markPopoutFrame()) {
    markWindowsFrame();
    return;
  }
  try {
    const observer = new MutationObserver(() => {
      if (markPopoutFrame()) {
        observer.disconnect();
        markWindowsFrame();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  } catch {
    /* 观察不到就退回 DOMContentLoaded 那条路 */
  }
}

/**
 * 把窗口里实际发生了什么报给主进程，供 /health 自检。
 *
 * 没有它就只能靠「看起来没变」这种猜测排错 —— 这个插件已经因为缺这一环
 * 反复返工过。字段选的都是「能一眼定位到是哪一层坏了」的东西。
 */
function reportDiag(stage) {
  try {
    const identity = parseIdentity();
    const root = document.documentElement;
    let shellProbe = 'n/a';
    try {
      const frame = document.querySelector('body *:has(> [data-shell-overlay])');
      if (!frame) {
        shellProbe = 'no-frame';
      } else {
        // 0.2.0 起不再藏外壳的兄弟节点，而是把 grid 列宽改成 0/1fr/0。
        // 所以这里报的是「列宽 + 各列 display」——列宽没生效会立刻看出来。
        const cols = getComputedStyle(frame).gridTemplateColumns || '?';
        const peers = [...frame.children].filter(
          (node) => !node.hasAttribute('data-shell-overlay'),
        );
        const displays = peers.length
          ? peers.map((node) => getComputedStyle(node).display).join(',')
          : 'no-peers';
        shellProbe = `${cols} | ${displays}`;
      }
    } catch {
      shellProbe = 'probe-failed';
    }
    // 会话界面到底有没有画出来。这是子窗白屏时最关键的一行：
    // 有 DOM 但看不见 → 样式问题；连 DOM 都没有 → 打开链路问题。
    let conversationProbe = 'unknown';
    try {
      const node = document.querySelector(
        '[class*=ConversationRoot],[data-conversation-scroll],[data-chat-flow],[data-composer-card],[data-pane=conversation]',
      );
      conversationProbe = node ? `yes:${node.tagName.toLowerCase()}` : 'no';
    } catch {
      conversationProbe = 'probe-failed';
    }
    ipcRenderer.send('dsh-popout:diag', {
      stage,
      href: String(window.location.href || ''),
      hash: String(window.location.hash || ''),
      role: identity.role,
      sessionId: identity.sessionId,
      groupId: identity.groupId,
      members: identity.members,
      active: identity.active,
      hasMark: Boolean(root && root.dataset.dshPopout === ''),
      shellCss: shellCssInstalled,
      shellProbe,
      conversation: conversationProbe,
      notices: document.querySelectorAll('[data-dsp-keep]').length,
      moduleLoader: typeof window.__ModuleLoader__,
      readyState: String(document.readyState || ''),
    });
  } catch {
    /* 报不上来不影响页面 */
  }
}

// documentElement 在 preload 执行时通常还没出现，所以两条路都铺上。
markAsap();
markWindowsFrame();

if (document.readyState === 'loading') {
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      markPopoutFrame();
      markWindowsFrame();
      reportDiag('dom-ready');
    },
    { once: true },
  );
} else {
  markPopoutFrame();
  markWindowsFrame();
  reportDiag('dom-ready');
}

// 页面稳定后再报一次：看我们的界面到底有没有画出来。
setTimeout(() => reportDiag('settled'), 1800);
// 集合窗口换成员时是改 hash 触发的，再补一次。
window.addEventListener('hashchange', () => {
  markPopoutFrame();
  setTimeout(() => reportDiag('hashchange'), 400);
});

try {
  contextBridge.exposeInMainWorld('__dshPopoutNative', {
    /**
     * 当前窗口的身份。client.js 优先读它，读不到才退回 location.hash ——
     * 这样即使页面自己的脚本跑得比 hash 可用更早，也认得出自己是谁。
     */
    readIdentity() {
      return parseIdentity();
    },
    /** 页面把自检信息报给主进程（client.js 在 apply 里报一次）。 */
    report(payload) {
      try {
        ipcRenderer.send('dsh-popout:diag', {
          stage: 'page',
          ...(payload && typeof payload === 'object' ? payload : {}),
        });
      } catch {
        /* 发不出去就少一条自检 */
      }
    },
    /**
     * 把当前配色交给主进程，用来刷原生标题栏按钮的颜色。
     * 参数是 CSS 颜色字符串（rgba(...)），主进程只做透传。
     */
    caption(color, symbolColor) {
      try {
        ipcRenderer.send('dsh-popout:caption', String(color), String(symbolColor));
      } catch {
        /* 发不出去就保持原配色 */
      }
    },
  });
} catch {
  /* 暴露不了就只是按钮配色不跟随，页面照常 */
}
