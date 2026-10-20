/**
 * dsh-session-popout · 宿主半侧（Host half）
 *
 * 职责：把「这个会话单独开一个窗口」「把几个会话合成一个窗口」翻译成对
 * 窗口管家的 HTTP 指令。真正建 BrowserWindow 的是 window/main.cjs 那个管家进程。
 *
 * 三级结构（用户定下的层级）：
 *   母级   = DSH 主窗口本身，不归本插件管；
 *   大子级 = 会话集合窗口，一个窗口装多个会话（QQ 的合并窗口）；
 *   子级   = 单会话窗口，一个窗口只装一个会话。
 *
 * 为什么窗口不在这里建：
 *   宿主进程是用 ELECTRON_RUN_AS_NODE 跑的纯 Node，require('electron') 拿不到
 *   BrowserWindow。所以本插件用 DSH 自带的 electron.exe 另起一个「管家」进程，
 *   由它持有全部窗口 —— 顺带解决了 Chromium 单实例锁（按 userData 判）和
 *   「合并/移出要实时生效」（只有同进程的窗口才能直接改 hash）两件事。
 *
 * 安全纪律：
 *   1. webServer 的路由注册在鉴权之前，必须自己调 connection.requestRejection 兜住；
 *   2. 只接受 GET，其余 405；
 *   3. 任何异常都不许冒泡到宿主（宿主以「entry 是否 activate」判定启动成败）；
 *   4. 窗口地址带 launch token，只经命令行交给本机的 electron.exe，不落盘、不回显；
 *   5. 管家只监听 127.0.0.1，且每个指令都校验一次性 token。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'dsh-session-popout';
const ROUTE_PREFIX = '/dsh-session-popout';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_APP = path.join(PLUGIN_DIR, 'window');

const DATA_DIR = path.join(os.homedir(), '.dsh', PLUGIN_ID);
const INFO_FILE = path.join(DATA_DIR, 'butler.json');
const BUTLER_USER_DATA = path.join(DATA_DIR, 'butler-profile');

/** 窗口里用来标记身份和目标的 hash 前缀。 */
const HASH_CHILD = '#dsh-popout=';
const HASH_GROUP = '#dsh-group=';

/** 本次宿主进程的管家令牌，只在本进程生命周期内有效。 */
const BUTLER_TOKEN = crypto.randomBytes(16).toString('hex');

/* -------------------------------------------------------------------------- *
 * 内存状态
 * -------------------------------------------------------------------------- */

/** 最近一次开窗请求的会话 id（hash 万一丢了，浏览器半侧可以从 /pending 取回）。 */
let lastPopoutSessionId = '';

/**
 * 弹窗点「收回」时留下的信号。主窗（dsh-app://app）和弹窗（http://127.0.0.1:<port>）
 * 不同源，BroadcastChannel / localStorage 都跨不过去，只能借宿主转一手。
 */
let pendingRecall = '';

/** findElectron 的结果缓存：找到一次就够了，别每次请求都探盘。 */
let cachedElectron = '';
/** findAppIcon 的结果缓存。 */
let cachedIcon;

/* -------------------------------------------------------------------------- *
 * 小工具
 * -------------------------------------------------------------------------- */

/**
 * 找 DSH 的应用图标，给子窗口当任务栏图标用。
 *
 * 桌面壳的图标就在安装目录的 resources/icon.png；找不到也无所谓，
 * 顶多是子窗口用 Electron 默认图标。返回 '' 表示没有。
 */
function findAppIcon() {
  if (cachedIcon !== undefined) return cachedIcon;
  cachedIcon = '';

  const override = process.env.DSH_POPOUT_ICON;
  const candidates = [];
  if (typeof override === 'string' && override.trim()) candidates.push(override.trim());

  // 宿主进程的可执行文件是 DSH 桌面端，图标就在它旁边的 resources/ 下。
  const execDir = path.dirname(process.execPath || '');
  if (execDir) {
    candidates.push(path.join(execDir, 'resources', 'icon.png'));
    candidates.push(path.join(path.dirname(execDir), 'resources', 'icon.png'));
  }
  try {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'icon.png'));
  } catch {
    /* 没有这个全局就算了 */
  }
  try {
    const appPath = process.env.PORTABLE_EXECUTABLE_DIR;
    if (appPath) candidates.push(path.join(appPath, 'resources', 'icon.png'));
  } catch {
    /* 忽略 */
  }
  // 常见安装位置的兜底（用户可能把 Electron 挂到别处跑宿主）。
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA, 'Programs', 'deepseek-harness', 'resources', 'icon.png'),
    );
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedIcon = candidate;
        return cachedIcon;
      }
    } catch {
      /* 继续下一个候选 */
    }
  }
  return cachedIcon;
}

/**
 * 取 DSH 当前的深浅色，用来让子窗口的标题栏/背景跟母窗口一致。
 *
 * 主题偏好存在宿主的 settings 里（命名空间 ui-theme、字段 preference，
 * 取值 light / dark / system）。宿主半侧读不到渲染层解析后的快照，
 * 所以这里自己解一遍：固定偏好直接用，system 就看系统。
 * 读不到就返回空串，让管家按系统默认走。
 */
function currentScheme(ctx) {
  let preference = '';
  try {
    const settings = ctx.get('settings');
    if (settings && typeof settings.describe === 'function') {
      const forms = settings.describe();
      if (Array.isArray(forms)) {
        for (const item of forms) {
          if (!item || typeof item !== 'object') continue;
          // 表单按 profile 条目 id 索引，主题那一条的 ns / id 里带 ui-theme。
          const label = `${item.ns || ''} ${item.id || ''}`;
          if (!label.includes('ui-theme')) continue;
          const value = item.value;
          if (value && typeof value === 'object' && typeof value.preference === 'string') {
            preference = value.preference;
            break;
          }
        }
      }
    }
  } catch {
    /* 读不到就按系统走 */
  }
  if (preference === 'dark' || preference === 'light') return preference;
  return '';
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 无权限时由后续操作报错并回给前端 */
  }
}

function safeKey(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
}
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 调用宿主鉴权：返回 401/403 表示这个请求不该被服务。 */
function rejectionOf(ctx, req) {
  try {
    const connection = ctx.get('connection');
    const rejection = connection?.requestRejection?.(req);
    return typeof rejection === 'number' ? rejection : 0;
  } catch {
    // 鉴权服务不可用时宁可拒绝，也不放行。
    return 401;
  }
}

/**
 * 找到 DSH 桌面端自带的 Electron。
 *
 * 优先级：环境变量 → 运行中的宿主自己的可执行文件（桌面壳就是这么起宿主的）
 * → ~/.dsh/electron/ 下的固定位置。
 */
/**
 * 找 DSH 桌面版自带的 Electron。
 *
 * 这个插件需要在 DSH 之外再开几个原生窗口，但 Harness 本体不提供这种能力，
 * 所以借桌面版已经装好的那份 Electron 来当窗口宿主（不额外下载、不额外安装）。
 *
 * 查找顺序（先到先得）：
 *   1. 环境变量 DSH_POPOUT_ELECTRON —— 用户在系统别处装了 Electron 时用这个指定；
 *   2. 当前进程自己就是 Electron —— 在 Electron 内部启动时直接用自己；
 *   3. <home>/.dsh/electron/ —— DSH 桌面版的默认安装位置（各平台路径不同）。
 *
 * 三条都落空就返回空串，由调用方抛出带指引的错误，而不是静默失败。
 */
function findElectron() {
  if (cachedElectron && fs.existsSync(cachedElectron)) return cachedElectron;

  const override = process.env.DSH_POPOUT_ELECTRON;
  if (typeof override === 'string' && override.trim() && fs.existsSync(override.trim())) {
    cachedElectron = override.trim();
    return cachedElectron;
  }

  const execPath = process.execPath;
  if (
    typeof execPath === 'string' &&
    execPath &&
    /electron/i.test(path.basename(execPath)) &&
    fs.existsSync(execPath)
  ) {
    cachedElectron = execPath;
    return cachedElectron;
  }

  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [path.join(home, '.dsh', 'electron', 'electron.exe')]
      : process.platform === 'darwin'
        ? [
            path.join(home, '.dsh', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
            path.join(home, '.dsh', 'electron', 'electron'),
          ]
        : [path.join(home, '.dsh', 'electron', 'electron')];

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedElectron = candidate;
        return cachedElectron;
      }
    } catch {
      /* 继续下一个候选 */
    }
  }
  return '';
}

/* -------------------------------------------------------------------------- *
 * 窗口地址
 * -------------------------------------------------------------------------- */

function baseUrlOf(ctx) {
  const connection = ctx.get('connection');
  const webServer = ctx.get('webServer');
  if (!connection || typeof connection.authenticatedUrl !== 'function') {
    throw new Error('宿主没有提供 connection.authenticatedUrl，无法造出已登录的窗口地址');
  }
  if (!webServer || typeof webServer.getOrigin !== 'function') {
    throw new Error('宿主没有提供 webServer.getOrigin，取不到监听端口');
  }
  // 带 launch token 的首页；浏览器落 cookie 后会 303 到干净的 ./，hash 会保留。
  return connection.authenticatedUrl(`${webServer.getOrigin()}/`);
}

function childUrlOf(ctx, sessionId) {
  const url = new URL(baseUrlOf(ctx));
  url.hash = `${HASH_CHILD}${encodeURIComponent(sessionId)}`;
  return url.href;
}

/**
 * 集合窗口的初始地址。
 *
 * 成员表由管家保管（合并是「把一个窗口拖到另一个窗口上」，宿主根本不在场），
 * 所以这里只负责把身份和入口给到页面，成员由管家随后用 hash 推给窗口。
 */
function groupUrlOf(ctx, groupId) {
  const url = new URL(baseUrlOf(ctx));
  url.hash = `${HASH_GROUP}${encodeURIComponent(groupId)}`;
  return url.href;
}

/** 干净首页地址（不带 launch token）。拆窗口时管家要用它重新拼地址。 */
function baseOf(ctx) {
  try {
    return new URL(baseUrlOf(ctx)).origin + '/';
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- *
 * 管家进程
 * -------------------------------------------------------------------------- */

/**
 * 管家代码指纹（两个窗口进程文件的 size + mtime）。
 *
 * 为什么需要它：`ensureButler` 原来的复用条件是「info 里的端口 ping 得通」，
 * 于是上一个宿主留下的管家进程会一直活着、一直用**旧的** main.cjs / preload.cjs
 * 开窗 —— 改了窗口代码却看不到任何变化，最迷惑的一种就是它。现在把指纹写进
 * info，对不上就把旧管家请退、重新起一个。
 */
function butlerStamp() {
  const parts = [];
  for (const name of ['main.cjs', 'preload.cjs']) {
    try {
      const stat = fs.statSync(path.join(WINDOW_APP, name));
      parts.push(`${name}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return parts.join('|');
}

function readInfo() {
  try {
    const raw = fs.readFileSync(INFO_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.port !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function pingButler(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: `/health?token=${BUTLER_TOKEN}`, timeout: 1200 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            done(res.statusCode === 200 && JSON.parse(body).ok === true);
          } catch {
            done(false);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  });
}

/** 给管家下一条指令。失败返回 {ok:false}，绝不抛。 */
function callButler(port, route, params) {
  return new Promise((resolve) => {
    const search = new URLSearchParams({ token: BUTLER_TOKEN, ...params });
    const req = http.get(
      { host: '127.0.0.1', port, path: `${route}?${search.toString()}`, timeout: 4000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ ok: res.statusCode === 200 && parsed.ok === true, body: parsed });
          } catch {
            resolve({ ok: false, body: { ok: false, error: 'bad-response' } });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: { ok: false, error: 'timeout' } });
    });
    req.on('error', (err) => resolve({ ok: false, body: { ok: false, error: err.message } }));
  });
}

/**
 * 把「上一个宿主留下的管家」请走。
 *
 * 三种情况都要处理，因为它们各自的失败方式不一样：
 *   1. 端口还通、令牌也对（同一宿主进程复用）→ 不用管，调用方已处理；
 *   2. 端口还通但那是我上个宿主的令牌，本地这把新令牌问不出话 → 只能按 pid 结束；
 *   3. 端口不通但进程还在（卡住 / 正在退出）→ 也按 pid 结束。
 *
 * 为什么非要它退干净：管家进程持有 butler-profile 目录的 Chromium 单实例锁，
 * 旧的不退，新起的那个 requestSingleInstanceLock() 失败会立刻退出，于是拖会话
 * 永远没反应。这条是「改了代码毫无变化」的第二大来源。
 */
async function releaseStaleButler(info) {
  if (!info) return true;
  const { port, pid } = info;

  if (typeof port === 'number' && (await pingButler(port))) {
    // 能应答说明它的令牌就是当前这把，走正规的关机通道。
    await callButler(port, '/shutdown', {}).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(150);
      if (!(await pingButler(port))) break;
    }
    if (!(await pingButler(port))) return true;
  }

  if (typeof pid !== 'number') return typeof port === 'number' ? !(await pingButler(port)) : true;

  // 到这里说明端口不说话、或者说了但我们没资格让它关。直接结束进程。
  try {
    process.kill(pid);
  } catch {
    /* 已经退出（ESRCH）或不允许 —— 下面统一按端口是否真的静默来判断 */
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(150);
    const alive = typeof port === 'number' ? await pingButler(port) : false;
    if (!alive && (await processGone(pid))) return true;
  }
  return typeof port === 'number' ? !(await pingButler(port)) : true;
}

/** 进程是否真的不在了。Windows 上 kill(pid, 0) 会抛 ESRCH。 */
function processGone(pid) {
  return new Promise((resolve) => {
    try {
      process.kill(pid, 0);
    } catch (err) {
      resolve(err && err.code === 'ESRCH');
      return;
    }
    resolve(false);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保管家在跑，返回它的端口（拿不到就抛）。
 *
 * 就绪判据是「真的能应答 /health」，不是「进程还在」—— 一个卡住的进程会让
 * 所有开窗请求静静失败，比直接报错更难查。
 */
async function ensureButler(ctx) {
  const electron = findElectron();
  if (!electron) {
    const err = new Error('没找到 DSH 自带的 Electron；可用环境变量 DSH_POPOUT_ELECTRON 指定路径');
    err.code = 'no-electron';
    throw err;
  }
  if (!fs.existsSync(path.join(WINDOW_APP, 'main.cjs'))) {
    const err = new Error(`窗口管家入口不见了：${path.join(WINDOW_APP, 'main.cjs')}`);
    err.code = 'butler-missing';
    throw err;
  }

  const existing = readInfo();
  const stamp = butlerStamp();
  if (existing) {
    // 令牌是本宿主进程新生成的，所以「能 ping 通」几乎总意味着同进程复用；
    // 指纹对上就直接用，对不上就先把它请走（见 releaseStaleButler 的三条分支）。
    const reachable = typeof existing.port === 'number' && (await pingButler(existing.port));
    if (reachable && existing.stamp === stamp) return existing.port;
    const released = await releaseStaleButler(existing);
    if (!released) {
      const err = new Error('上一个窗口管家没能退出，新的起不来（它占着窗口进程的单实例锁）');
      err.code = 'butler-stuck';
      throw err;
    }
  }

  ensureDir(DATA_DIR);
  // 残留的 info 指向已经不在的进程，先清掉再起新的。
  try {
    fs.rmSync(INFO_FILE, { force: true });
  } catch {
    /* 忽略 */
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const argv = [
    WINDOW_APP,
    `--dsh-userdata=${BUTLER_USER_DATA}`,
    `--dsh-info=${INFO_FILE}`,
    `--dsh-token=${BUTLER_TOKEN}`,
    `--dsh-stamp=${stamp}`,
  ];
  // 让子窗口看上去就是 DSH 的一部分：同一套图标、同一套深浅色。
  const icon = findAppIcon();
  if (icon) argv.push(`--dsh-icon=${icon}`);
  const scheme = currentScheme(ctx);
  if (scheme) argv.push(`--dsh-theme=${scheme}`);

  const child = spawn(electron, argv, {
    cwd: WINDOW_APP,
    env,
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
  });
  child.on('error', () => {
    /* 起不来由下面的轮询交代 */
  });
  child.unref();

  // Electron 冷启动一般 1 秒内就绪；给 8 秒，超时如实报错。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(200);
    const info = readInfo();
    if (info && (await pingButler(info.port))) return info.port;
  }

  const err = new Error('窗口管家没能启动（8 秒内没有应答）');
  err.code = 'butler-timeout';
  throw err;
}

/* -------------------------------------------------------------------------- *
 * 会话集合的 id
 *
 * 成员表归窗口管家管（合并是「把一个窗口拖到另一个窗口上」，宿主不在场也照样发生），
 * 这里只负责在「还没有集合」时给一个 id，剩下的都问管家。
 * -------------------------------------------------------------------------- */

function newGroupId() {
  return `g-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export const name = PLUGIN_ID;
export const inject = ['webServer', 'connection'];

export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const rejection = rejectionOf(ctx, req);
      if (rejection) {
        sendJson(res, rejection, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }

      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
        const param = (name) => (url.searchParams.get(name) || '').trim();
        /** 松手时的屏幕坐标：窗口就开在那儿。 */
        const point = () => {
          const x = Number(param('x'));
          const y = Number(param('y'));
          return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)
            ? { x: String(Math.round(x)), y: String(Math.round(y)) }
            : null;
        };

        /* ---- 无窗口动作的小指令 ---- */

        if (route === '/pending') {
          sendJson(res, 200, { ok: true, sessionId: lastPopoutSessionId || null });
          return;
        }
        if (route === '/recall') {
          const sessionId = param('sessionId');
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: 'missing-session-id' });
            return;
          }
          pendingRecall = sessionId;
          sendJson(res, 200, { ok: true });
          return;
        }
        if (route === '/take-recall') {
          const sessionId = pendingRecall;
          pendingRecall = '';
          sendJson(res, 200, { ok: true, sessionId: sessionId || null });
          return;
        }

        /* ---- 需要窗口的动作 ---- */

        const needsWindow =
          route === '/open' ||
          route === '/open-group' ||
          route === '/merge' ||
          route === '/unmerge' ||
          route === '/group';
        if (!needsWindow) {
          sendJson(res, 404, { ok: false, error: 'not-found', route });
          return;
        }

        const port = await ensureButler(ctx);

        if (route === '/group') {
          const groupId = param('groupId');
          const result = await callButler(port, '/group', { groupId });
          sendJson(res, result.ok ? 200 : 500, {
            ...result.body,
            groupId,
            sessionIds: Array.isArray(result.body && result.body.members) ? result.body.members : [],
          });
          return;
        }

        if (route === '/open') {
          const sessionId = param('sessionId');
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: 'missing-session-id' });
            return;
          }
          lastPopoutSessionId = sessionId;
          const drop = point();
          const result = await callButler(port, '/open', {
            key: `s:${sessionId}`,
            url: childUrlOf(ctx, sessionId),
            kind: 'child',
            sessionId,
            base: baseOf(ctx),
            ...(drop || {}),
          });
          sendJson(res, result.ok ? 200 : 500, { ...result.body, sessionId });
          return;
        }

        if (route === '/open-group' || route === '/merge') {
          // 两者差别只在「要不要把这个会话放进去」：
          // open-group 是新建/沿用集合并装进去，merge 是明确往里加。
          const sessionId = param('sessionId');
          const groupId = param('groupId') || newGroupId();
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: 'missing-session-id' });
            return;
          }
          lastPopoutSessionId = sessionId;
          const drop = point();
          const opened = await callButler(port, '/open', {
            key: `g:${groupId}`,
            url: groupUrlOf(ctx, groupId),
            kind: 'group',
            groupId,
            sessionId,
            base: baseOf(ctx),
            ...(drop || {}),
          });
          // 集合窗口已经把这个会话显示出来了，它自己的单窗就可以退了，
          // 否则用户会看到同一个会话两份。
          await callButler(port, '/close', { key: `s:${sessionId}` });
          sendJson(res, opened.ok ? 200 : 500, {
            ...opened.body,
            groupId,
            sessionIds: Array.isArray(opened.body && opened.body.members) ? opened.body.members : [],
          });
          return;
        }

        // /unmerge —— 把会话从集合里拆出来，重新变成它自己的子级窗口。
        const sessionId = param('sessionId');
        const groupId = param('groupId');
        if (!sessionId || !groupId) {
          sendJson(res, 400, { ok: false, error: 'missing-args' });
          return;
        }
        lastPopoutSessionId = sessionId;
        const split = await callButler(port, '/unmerge', {
          groupId,
          sessionId,
          base: baseOf(ctx),
        });
        sendJson(res, split.ok ? 200 : 500, { ...split.body, groupId, sessionId });
      } catch (err) {
        const code = err && err.code ? err.code : 'internal-error';
        sendJson(res, 500, { ok: false, error: code, message: err?.message || String(err) });
      }
    },
  });

  ctx.effect(() => dispose, `${PLUGIN_ID}: ${ROUTE_PREFIX} 路由`);
  ctx.effect(() => watchClientBundle(ctx), `${PLUGIN_ID}: 前端自动重建`);
}

/**
 * 盯着自己的 client.js，改了就通知宿主重新取 bundle。
 *
 * 为什么需要这个：clientModules 只在启动时把各插件的 client.js 读进内存，
 * 之后要靠 dsh-client-hmr 那个开发期插件轮询文件时间戳才会重建 —— 而 HMR
 * 默认不装（本机 profile 里就没有它）。结果是改完前端必须重启整个 DSH 才生效，
 * 用户点按钮看到的仍是旧代码，白等一轮。
 *
 * 这里自己按同样的方式比一次 mtime，变了就调 clientModules.rebuilt(自己)。
 * 全程 try/catch：它只是省一次重启，坏了也不该影响插件本身。
 */
function watchClientBundle(ctx) {
  let timer = null;
  try {
    const modules = ctx.get('clientModules');
    if (!modules || typeof modules.rebuilt !== 'function') return () => {};
    const clientPath = path.join(PLUGIN_DIR, 'client.js');
    const stamp = () => {
      const stat = fs.statSync(clientPath);
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    };
    let last = stamp();
    timer = setInterval(() => {
      let now;
      try {
        now = stamp();
      } catch {
        return;
      }
      if (now === last) return;
      last = now;
      try {
        modules.rebuilt(PLUGIN_ID);
        ctx.logger?.info?.(`${PLUGIN_ID}: client bundle 已更新，刷新页面即可生效`);
      } catch (err) {
        ctx.logger?.warn?.(`${PLUGIN_ID}: client bundle 重建失败 ${err?.message || err}`);
      }
    }, 1000);
    timer.unref?.();
  } catch {
    /* 拿不到 clientModules 就算了，重启照样生效 */
  }
  return () => {
    if (timer) clearInterval(timer);
  };
}
