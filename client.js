/**
 * dsh-session-popout · 浏览器半侧（Client half）
 *
 * 同一个 client.js 按 location.hash 认领三种身份：
 *   母级（无 hash）  —— DSH 主窗口。从左侧会话栏把条目拖出来，就在松手处开一个子窗；
 *                      同时轮询宿主，接住子窗发来的「收回会话列表」。
 *   子级（#dsh-popout=…）—— 只装一个会话的窄窗（QQ 的单聊窗口）。
 *   大子级（#dsh-group=…）—— 装多个会话的集合窗口（QQ 的合并窗口），
 *                      用会话头部的下拉换人，不再自绘左栏。
 *
 * 为什么靠 hash：宿主开窗用的是 authenticatedUrl()（带 ?token=），首页会回一个
 * 303 到相对 `./`，实测这时 hash 会被完整保留。
 *
 * 界面纪律（0.2.0 起的做法，别再退回自绘）：
 *   子窗打开的就是 DSH 自己的页面，对话流、输入栏、模型选择、工具栏、Markdown 渲染
 *   全在宿主 `main.conversation` 子树里。插件**不重画**它们，只做三件事：
 *     1) 用 `uiWorkspace.openSession(id)` 让宿主把该会话显示到主区域；
 *     2) 把左侧导航栏收起来（ctx.layout.toggleSidebar 一次），看起来就是「切下来的会话」；
 *     3) 往 `conversation.session.header.utilities` 塞自己的按钮（收回 / 拆分 / 换会话）。
 *   旧版自绘的 .dsp-flow/.dsp-bubble/.dsp-composer 已删除 —— 它把 Markdown 当纯文本画，
 *   也丢掉了宿主的工具栏与设置项。
 *
 * 纪律：
 *   - 样式只走 --dsw-alias-* / --dsw-specific-* 主题 token，不写死颜色；
 *   - 快照必须换引用，否则 useSyncExternalStore 判定「没变」，界面永不重渲染；
 *   - 任何可选 UI 的异常都不许冒泡 —— 炸了就是整个应用打不开。
 */

(() => {
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-session-popout',
      factory(require) {
        const React = require('react');
        const h = React.createElement;

        const HASH_CHILD = '#dsh-popout=';
        const HASH_GROUP = '#dsh-group=';
        const ROUTE = '/dsh-session-popout';
        const ROUTE_RECALL = `${ROUTE}/recall`;
        const ROUTE_TAKE_RECALL = `${ROUTE}/take-recall`;
        const ROUTE_OPEN = `${ROUTE}/open`;
        const ROUTE_UNMERGE = `${ROUTE}/unmerge`;

        /** 主窗轮询「收回」信号的间隔；子级窗口与主窗不同源，只能借宿主转发。 */
        const RECALL_POLL_MS = 2000;

        /**
         * 开会话的重试节奏。
         *
         * 会话目录（ctx.sessions.list）是异步拉的，phase 从 'pending' 变 'ready' 之前
         * 调 retain/openSession 会抛 `sessions.retain: unknown session <id>`。
         * 子窗刚起来那一刻目录几乎必然还没到 —— 旧版就是在这里直接失败，
         * 用户看到「第一次拖动打开报错，进别的会话再点回来才好」（第二次目录已 ready）。
         * 现在一律等到 ready 且 id 真的在目录里再开，失败按 200ms 退避重来，最多 20 秒。
         */
        const OPEN_RETRY_MS = 200;
        const MAX_OPEN_ATTEMPTS = 100;

        /**
         * 打开成功后的一次复核。
         *
         * 调过 openSession 不代表它一直留在屏幕上：宿主自己还有一条异步的
         * 「恢复上次会话」链（workspace 的 watchNavigation → restoreSelection），
         * 它可能在我们之后才落地，把视图换成 localStorage 里记的旧会话 ——
         * 用户看到的就是「窗口开了，但显示的不是我拖的那个」。
         * 这里在开窗后隔 300ms 回看一眼，被顶掉就再要一次，最多 3 次；
         * 之后无论结果如何都收手，绝不跟用户在窗里的手动切换打架。
         */
        const OPEN_GUARD_MS = 300;
        const OPEN_REGRABS = 3;

        /* ------------------------------------------------------------------ *
         * 小工具
         * ------------------------------------------------------------------ */

        /**
         * 从 preload 桥取一份身份（子窗口才有）。
         *
         * preload 手里有主进程建窗时直接传下来的角色
         * （`--dsh-popout-role=child|group`），这是唯一不依赖页面状态的来源。
         * 母窗没有这个桥，返回 null。
         */
        function identityFromBridge() {
          try {
            const bridge = window.__dshPopoutNative;
            if (bridge && typeof bridge.readIdentity === 'function') {
              const value = bridge.readIdentity();
              if (value && typeof value === 'object' && (value.role === 'child' || value.role === 'group')) {
                return value;
              }
            }
          } catch {
            /* 桥不可用就往下走属性那条路 */
          }
          // 兜底：preload / 窗口进程都会把角色写在 <html> 上。
          // 这条不依赖任何 API，页面脚本再早也读得到。
          try {
            const root = document.documentElement;
            const dataset = root ? root.dataset || {} : {};
            const role = dataset.dshPopoutRole;
            if (role === 'child' || role === 'group') {
              const sessionId = dataset.dshPopoutSession || '';
              const groupId = dataset.dshPopoutGroup || '';
              return {
                role,
                sessionId: role === 'child' ? sessionId : '',
                groupId: role === 'group' ? groupId : '',
                members: role === 'group' && sessionId ? [sessionId] : [],
                active: role === 'group' ? sessionId : '',
              };
            }
          } catch {
            /* 读不到就当没有 */
          }
          return null;
        }

        /**
         * 从 hash 里认出自己是谁。
         * 返回 {role:'parent'|'child'|'group', sessionId, groupId, members, active}。
         *
         * 集合窗口的成员表由窗口管家保管（合并是拖窗口标题条完成的，宿主不在场），
         * 管家改完成员会把新成员拼进 hash 推过来，所以这里能直接读到，不必再回宿主问。
         */
        function readIdentity() {
          // 先问 preload：角色是主进程建窗时定死的，比 hash 可靠得多。
          // 只在 hash 里拿不到具体内容时才用它兜底（比如 hash 还没推过来）。
          const bridged = identityFromBridge();
          const none = { role: 'parent', sessionId: '', groupId: '', members: [], active: '' };
          try {
            const hash = window.location.hash || '';
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
            // hash 没内容：只要桥说这是弹窗，角色就照桥的算。
            if (bridged) return { ...none, ...bridged };
            return none;
          } catch {
            return bridged ? { ...none, ...bridged } : none;
          }
        }

        function messageOf(err) {
          if (!err) return '未知错误';
          if (typeof err === 'string') return err;
          return err.message || String(err);
        }

        /** 发一条宿主指令，统一成 {ok, body}，绝不抛。 */
        function callHost(route, params) {
          const search = new URLSearchParams(params || {});
          const url = search.toString() ? `${route}?${search.toString()}` : route;
          return fetch(url, { credentials: 'same-origin' })
            .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
            .catch((err) => ({ ok: false, body: { ok: false, message: messageOf(err) } }));
        }

        /** 关窗；关不掉就留在原地（宿主可能禁了 window.close）。 */
        function closeWindow() {
          try {
            window.close();
          } catch {
            /* 同上 */
          }
        }

        /** 本次运行里是否开过窗口。没开过就完全不轮询 —— 不用这功能的人不该多付请求。 */
        let popoutOpenedOnce = false;

        /* ------------------------------------------------------------------ *
         * 拖拽中的提示条
         *
         * 拖出来一个窗口这件事本身没有任何视觉预告，不给一句话，
         * 用户根本不知道松手会发生什么（甚至会以为拖出窗口边界＝取消）。
         * ------------------------------------------------------------------ */

        let hintOn = false;
        const hintListeners = new Set();

        function setHintOn(next) {
          const value = Boolean(next);
          if (value === hintOn) return;
          // 快照必须换引用：原地改会让 useSyncExternalStore 判定「没变」。
          hintOn = value;
          for (const listener of [...hintListeners]) {
            try {
              listener();
            } catch {
              /* 单个订阅者出错不该影响别人 */
            }
          }
        }

        function useHintOn() {
          return React.useSyncExternalStore(
            React.useCallback((listener) => {
              hintListeners.add(listener);
              return () => hintListeners.delete(listener);
            }, []),
            () => hintOn,
            () => false,
          );
        }

        function DragHint() {
          const on = useHintOn();
          // Styles 常驻挂载，只切换提示条本身：
          // 每次开关都重挂 <style> 会让整份样式闪一下。
          return h(
            React.Fragment,
            null,
            h(Styles, null),
            on ? h('div', { className: 'dsp-drag-hint' }, '松手：把这个会话拖成独立窗口') : null,
          );
        }

        function installDragOut() {
          if (typeof document === 'undefined') return undefined;

          let dragging = '';
          let droppedOnRow = false;

          const rowOf = (target) => {
            try {
              const element = target && target.closest ? target.closest('[data-row-key]') : null;
              return element || null;
            } catch {
              return null;
            }
          };

          const onDragStart = (event) => {
            dragging = '';
            droppedOnRow = false;
            try {
              const row = rowOf(event.target);
              const key = row ? row.getAttribute('data-row-key') || '' : '';
              if (key.startsWith('session:')) dragging = key.slice('session:'.length);
            } catch {
              dragging = '';
            }
            setHintOn(Boolean(dragging));
          };

          /*
           * 拖到任何地方都算有效落点，所以一律 preventDefault ——
           * 否则鼠标会显示「禁止」光标，用户会以为拖不出去。
           *
           * 这里是捕获阶段，跑在宿主自己的 dragover 之前：会话行上宿主还会把
           * dropEffect 改成 'move'（后设的赢），所以排序手势的观感一点没变。
           */
          const onDragOver = (event) => {
            if (!dragging) return;
            event.preventDefault();
            try {
              event.dataTransfer.dropEffect = 'copy';
            } catch {
              /* 设不上无所谓，光标难看一点而已 */
            }
          };

          const onDrop = (event) => {
            if (!dragging) return;
            // 落在会话行 / 工作区行 / 溢出行上，都归宿主管（排序、归档、展开）。
            if (rowOf(event.target)) {
              droppedOnRow = true;
              return;
            }
            // 落在空白处：明确表示「这个 drop 我们收了」。
            // 不拦的话浏览器会把这次拖拽当成被取消，光标和动画都会给错的反馈。
            event.preventDefault();
          };

          /*
           * Esc 取消拖动。浏览器不会在 dragend 里区分「取消」和「在窗外松手」——
           * 两者的 dropEffect 都是 none，而后者正是我们要接的动作。
           * 所以只能自己记一笔：拖动期间按 Esc 就把这次拖拽作废。
           */
          const onKeyDown = (event) => {
            if (!dragging) return;
            if (event.key === 'Escape' || event.key === 'Esc') {
              dragging = '';
              droppedOnRow = false;
              setHintOn(false);
            }
          };

          const onDragEnd = (event) => {
            const sessionId = dragging;
            const reordered = droppedOnRow;
            dragging = '';
            droppedOnRow = false;
            setHintOn(false);
            if (!sessionId || reordered) return;

            /*
             * 只在 dragend 自带真实屏幕坐标时才报坐标。
             *
             * 拖出窗口边界再松手，这里常常拿到 0 —— 那时不能拿窗口内最后一次
             * dragover 的坐标顶替（那会把窗口开在用户早就不看的地方）；
             * 干脆不报，让主进程问系统光标，松手那一瞬鼠标就停在落点上。
             */
            let x = 0;
            let y = 0;
            try {
              x = Number(event.screenX);
              y = Number(event.screenY);
            } catch {
              x = 0;
              y = 0;
            }
            const params = { sessionId };
            if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) {
              params.x = String(Math.round(x));
              params.y = String(Math.round(y));
            }
            callHost(ROUTE_OPEN, params).then(({ ok, body }) => {
              if (ok && body && body.ok !== false) {
                popoutOpenedOnce = true;
                return;
              }
              const reason = (body && (body.message || body.error)) || '宿主没有说明原因';
              window.alert(`拖不出去：${reason}`);
            });
          };

          document.addEventListener('dragstart', onDragStart, true);
          document.addEventListener('dragover', onDragOver, true);
          document.addEventListener('drop', onDrop, true);
          document.addEventListener('dragend', onDragEnd, true);
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            setHintOn(false);
            document.removeEventListener('dragstart', onDragStart, true);
            document.removeEventListener('dragover', onDragOver, true);
            document.removeEventListener('drop', onDrop, true);
            document.removeEventListener('dragend', onDragEnd, true);
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }

        /** 订阅一个 ObservableSnapshot（getSnapshot/subscribe 对）。 */
        function useSnapshot(source) {
          const subscribe = React.useCallback((onChange) => {
            try {
              return source.subscribe(onChange);
            } catch {
              return () => {};
            }
          }, [source]);
          const read = React.useCallback(() => {
            try {
              return source.getSnapshot();
            } catch {
              return undefined;
            }
          }, [source]);
          return React.useSyncExternalStore(subscribe, read, read);
        }

        /* ------------------------------------------------------------------ *
         * 打开会话：等目录 ready，再让宿主自己渲染
         * ------------------------------------------------------------------ */

        /** 会话目录里是否已经有这个 id（phase ready 才算数）。 */
        function isListed(snapshot, sessionId) {
          if (!snapshot || !sessionId) return false;
          if (snapshot.phase !== 'ready') return false;
          const byId = snapshot.byId || {};
          if (byId[sessionId]) return true;
          const ids = Array.isArray(snapshot.ids) ? snapshot.ids : [];
          return ids.includes(sessionId);
        }

        /**
         * 这个会话现在是不是宿主的「主视图」。
         *
         * 宿主给每个会话记了一份 retainedBy 计数，主视图占用的那个是 mainView > 0。
         * 我们用它回头核对：调用过 openSession 不等于它现在还在屏幕上 ——
         * 宿主自己那条异步恢复链可能晚一步把视图换成别的会话。
         */
        function isMainView(snapshot, sessionId) {
          if (!snapshot || !sessionId) return false;
          const summary = (snapshot.byId || {})[sessionId];
          if (!summary) return false;
          return Number(summary.retainedBy && summary.retainedBy.mainView) > 0;
        }

        let openState = { phase: 'idle', message: '' };
        const openListeners = new Set();

        function setOpenState(next) {
          if (next.phase === openState.phase && next.message === openState.message) return;
          openState = next;
          for (const listener of [...openListeners]) {
            try {
              listener();
            } catch {
              /* 单个订阅者出错不该影响别人 */
            }
          }
        }

        function useOpenState() {
          return React.useSyncExternalStore(
            React.useCallback((listener) => {
              openListeners.add(listener);
              return () => openListeners.delete(listener);
            }, []),
            () => openState,
            () => openState,
          );
        }

        /**
         * 主动催一次会话列表。
         *
         * 宿主自己只在「连接建立」那一瞬拉过一次目录（SessionManager.handleConnected），
         * 新窗口之所以首开必炸，就是因为那一刻的请求还没回来。光等也能等到下次
         * 别处触发，但那可能是几十秒后；这里直接踢一脚，让它立刻重拉。
         * refreshList 自带单飞（listInflight），重复调用不会打出请求风暴。
         */
        function nudgeCatalog(ctx) {
          try {
            const pending = ctx.sessions.refresh();
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          } catch {
            /* 催不动就继续等，不影响重试循环 */
          }
        }

        /**
         * 掐掉宿主那条还没跑完的「恢复上次会话」异步链。
         *
         * workspace 服务里有个 watchNavigation：会话目录一 ready，它就读 localStorage
         * 里记的上次选中会话自己 restore 一次（子窗和母窗同源，所以这份「上次会话」
         * 直接继承母窗）。其中「上次是个空会话 / 要回工作区里捞」那条分支是异步的，
         * 中间会 await 建会话、连工作区的 RPC，几百毫秒后才 replaceMain —— 那时我们
         * 已经把目标会话画上去了，就会被它悄悄顶掉。
         *
         * 那条分支拿的是 AbortSignal.any([layout.beginNavigation(), lifetime])，
         * 所以在我们动手前调一次 beginNavigation() 就能让它的
         * `if (!navigation.aborted)` 变成假，从而放过我们的选择。
         * 我们自己的 openSession 走 lifetime.signal，不受这次 abort 影响。
         */
        function abortHostRestore(ctx) {
          try {
            ctx.layout.beginNavigation();
          } catch {
            /* 掐不掉最多是被它抢一次视图，不影响能不能打开 */
          }
        }

        /**
         * 把 sessionId 显示到宿主主区域。返回取消函数。
         *
         * openSession 内部同步调 sessions.retain，目录没到时直接抛
         * `sessions.retain: unknown session <id>`；所以先等 isListed 再调，
         * 调的时候仍可能撞上宿主内部一拍没跟上，一律退避重试。
         *
         * 打开成功之后还要盯着看一小会儿：宿主那条异步的「恢复上次会话」可能在
         * 我们之后才落地，把视图悄悄换成别的会话（用户看到的就是「窗口打开了但
         * 显示的不是我要的那个」）。这段盯防只在开窗后几秒内有效，之后用户自己
         * 在窗里切换会话我们绝不干预。
         */
        function openConversation(ctx, sessionId) {
          let cancelled = false;
          let timer = null;
          let attempts = 0;
          let lastNudge = 0;
          let opened = false;
          let regrabs = 0;

          const finish = () => {
            setOpenState({ phase: 'done', message: '' });
          };

          const tick = () => {
            if (cancelled) return;

            let snapshot;
            try {
              snapshot = ctx.sessions.list.getSnapshot();
            } catch {
              snapshot = undefined;
            }
            const listed = isListed(snapshot, sessionId);

            // 已经画上去了：隔一拍核对一次，确认没被宿主的自动恢复顶掉。
            if (opened) {
              if (isMainView(snapshot, sessionId) || regrabs >= OPEN_REGRABS) {
                finish();
                return;
              }
              // 被换掉了 —— 再要一次。不算失败，也不弹提示。
              regrabs += 1;
              try {
                ctx.uiWorkspace.openSession(sessionId);
                timer = setTimeout(tick, OPEN_GUARD_MS);
                return;
              } catch {
                finish();
                return;
              }
            }

            // 每 2.5 秒最多催一次，避免把 refresh 打成请求风暴。
            if (!listed) {
              const now = Date.now();
              if (now - lastNudge > 2500) {
                lastNudge = now;
                nudgeCatalog(ctx);
              }
            }
            if (!listed) {
              setOpenState({ phase: 'waiting', message: '' });
            } else {
              try {
                // 先掐掉宿主那条可能还在跑的「恢复上次会话」，否则它稍后会把我们顶掉。
                abortHostRestore(ctx);
                ctx.uiWorkspace.openSession(sessionId);
                opened = true;
                // 隔一拍再看它还在不在 —— 宿主那条恢复链是异步的，可能比我们晚落地。
                timer = setTimeout(tick, OPEN_GUARD_MS);
                return;
              } catch (err) {
                // 目录刚 ready、宿主内部还有一拍没跟上：短退避再来。
                setOpenState({ phase: 'waiting', message: '' });
              }
            }
            attempts += 1;
            if (attempts >= MAX_OPEN_ATTEMPTS) {
              setOpenState({
                phase: 'error',
                message: `打不开这个会话：等了约 ${Math.round(
                  (MAX_OPEN_ATTEMPTS * OPEN_RETRY_MS) / 1000,
                )} 秒，宿主的会话目录还没就绪。`,
              });
              return;
            }
            timer = setTimeout(tick, OPEN_RETRY_MS);
          };

          tick();
          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
          };
        }

        /* ------------------------------------------------------------------ *
         * 收掉左侧导航栏
         *
         * 子窗里用户要的是「一个会话」，宿主那整条导航栏（新会话、工作区、插件入口）
         * 在单聊窗里只是噪音。布局层给的稳定标记是 frame 上的 data-sidebar-collapsed；
         * 收起后 collapsedWidth 在带 data-windows-titlebar 的窗口里是 0，
         * 于是整条栏连同折叠态的小窄条一起消失，剩下的就是会话区本身。
         * ------------------------------------------------------------------ */

        function shellFrame() {
          try {
            return document.querySelector(
              '[data-rightbar-collapsed],[data-sidebar-collapsed],[data-rightbar-fullscreen]',
            );
          } catch {
            return null;
          }
        }

        function collapseShell(ctx) {
          const frame = shellFrame();
          if (!frame) return false;
          try {
            if (!frame.hasAttribute('data-sidebar-collapsed')) ctx.layout.toggleSidebar();
            ctx.layout.closeRightbar();
          } catch {
            /* 布局服务异常不该把会话弄没 */
          }
          return true;
        }

        /** 挂载时 frame 可能还没渲染出来，短轮询几次；之后跟着窗口尺寸变化再校准。 */
        function installShellCollapse(ctx) {
          let cancelled = false;
          let timer = null;
          let attempts = 0;

          const settle = () => {
            if (cancelled) return;
            attempts += 1;
            const done = collapseShell(ctx);
            if (done || attempts >= 40) return;
            timer = setTimeout(settle, 100);
          };
          settle();

          let resizeTimer = null;
          const onResize = () => {
            if (resizeTimer !== null) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              if (!cancelled) collapseShell(ctx);
            }, 150);
          };
          try {
            window.addEventListener('resize', onResize);
          } catch {
            /* 加不上就是宽窗口下侧栏回来了，不影响会话 */
          }

          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            if (resizeTimer !== null) clearTimeout(resizeTimer);
            try {
              window.removeEventListener('resize', onResize);
            } catch {
              /* 同上 */
            }
          };
        }

        /* ------------------------------------------------------------------ *
         * 会话列表：同项目 = 同一个 cwd
         * ------------------------------------------------------------------ */

        function useSessionRows(ctx) {
          const snapshot = useSnapshot(ctx.sessions.list);
          return React.useMemo(() => {
            const ids = Array.isArray(snapshot && snapshot.ids) ? snapshot.ids : [];
            const byId = (snapshot && snapshot.byId) || {};
            const rows = [];
            for (const id of ids) {
              const summary = byId[id];
              // 子代理会话不进列表：用户要的是「这个项目里的对话」。
              if (!summary || summary.parentSessionId) continue;
              rows.push({
                id,
                title: summary.displayTitle || summary.cwd || String(id),
                cwd: summary.cwd || '',
                running: Boolean(summary.running),
                updatedAt: Number(summary.updatedAt) || 0,
              });
            }
            return rows;
          }, [snapshot]);
        }

        /* ------------------------------------------------------------------ *
         * 原生标题栏配色
         *
         * 母窗口右上角那三个按钮的颜色是 DSH 的 preload 盯着 body 算出来发的；
         * 子窗口没有那套东西，就自己算一次交给主进程，深浅色切换时按钮跟着变。
         * 拿不到 preload 通道（比如在普通浏览器里打开）就静默跳过。
         * ------------------------------------------------------------------ */

        function probeNativeColors() {
          try {
            const body = document.body;
            if (!body) return null;
            const probe = document.createElement('span');
            probe.style.cssText =
              'position:fixed;visibility:hidden;pointer-events:none;' +
              'background-color:var(--dsw-specific-sidebar-fill);' +
              'color:var(--dsw-alias-label-primary)';
            body.append(probe);
            const style = getComputedStyle(probe);
            const color = style.backgroundColor;
            const symbolColor = style.color;
            probe.remove();
            if (!color || !symbolColor) return null;

            // 计算值可能是 rgb()/var() 未解析；用 canvas 归一成 rgba，主进程才认。
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) return { color, symbolColor };
            const normalize = (input) => {
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = input;
              context.fillRect(0, 0, 1, 1);
              const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
              return `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / 255})`;
            };
            return { color: normalize(color), symbolColor: normalize(symbolColor) };
          } catch {
            return null;
          }
        }

        /** 把自己算出的配色报给主进程；返回值是清理函数。 */
        function useNativeCaption() {
          React.useEffect(() => {
            const native = typeof window !== 'undefined' ? window.__dshPopoutNative : undefined;
            if (!native || typeof native.caption !== 'function') return undefined;

            let last = '';
            const push = () => {
              const colors = probeNativeColors();
              if (!colors) return;
              const stamp = `${colors.color}|${colors.symbolColor}`;
              if (stamp === last) return;
              last = stamp;
              try {
                native.caption(colors.color, colors.symbolColor);
              } catch {
                /* 报不出去就保持启动时的配色 */
              }
            };

            push();
            // 主题切换 / 字体加载后配色可能变，盯着 body 的属性就够了。
            let observer = null;
            try {
              observer = new MutationObserver(push);
              observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] });
            } catch {
              observer = null;
            }
            return () => {
              if (observer) observer.disconnect();
            };
          }, []);
        }

        /** 跟踪 hash 里的身份；管家换会话 / 合并成员时推新 hash 过来，界面要跟着变。 */
        function useIdentity() {
          const [view, setView] = React.useState(() => readIdentity());
          React.useEffect(() => {
            const sync = () => setView(readIdentity());
            window.addEventListener('hashchange', sync);
            sync();
            return () => window.removeEventListener('hashchange', sync);
          }, []);
          return view;
        }

        /* ------------------------------------------------------------------ *
         * 样式（作为 React 元素渲染，卸载即移除）
         *
         * 只剩「藏掉别人的浮层」和几个原生风格的小按钮 —— 对话区一行样式的没有，
         * 因为它现在是宿主自己画的。
         * ------------------------------------------------------------------ */

        const CSS = `
/* 子窗要的是「只剩会话」这一个画面。这里不靠 display:none 藏侧栏那一列 ——
   那几列是 grid 子项，藏掉一个会让后面的列顶上去，整个布局错位；而且会话本身
   就画在框架的中列里，误藏一次就是整片空白（0.2.0 刚改成宿主原生渲染时踩过这个坑：
   preload 里还留着旧版「把外壳兄弟全藏掉」的规则，结果只剩一张壁纸）。
   现在侧栏靠 ctx.layout.toggleSidebar() 真正改成 0 宽，宿主的布局状态会自己把
   网格算成 0/1fr/0；preload.cjs 里还留一条同样意图的兜底规则，防止别的样式撑开。 */

/* 浮层里住着宿主自己的东西（预览版说明、额度提示、版本更新提示、各种 toast），
   以及别的插件挂的浮块（dsh-pet 用 1000、dsh-wb-balance 用 900）。
   子窗只留我们自己那条状态提示，其余一律不显示。
   定位浮层那一层不认 .BynINW_xxx 这类构建哈希类名，改用布局层给的稳定标记。

   两条 :not 是有原因的：槽位不保证把每个注册项直接铺成一层，也可能套一层容器。
   只认「自己带标记」的话，套了容器的那天我们的提示会被连容器一起藏掉；
   所以凡是「自己带标记」或「子树里有标记」的，都放行。 */
html[data-dsh-popout] [data-shell-overlay] > *:not([data-dsp-keep]):not(:has([data-dsp-keep])){
  display:none !important;}

html[data-dsh-popout],html[data-dsh-popout] body{background:var(--dsw-alias-bg-base);}

/* 母窗拖动会话条目时的提示条。position:fixed 是为了不受侧栏滚动容器影响；
   pointer-events:none 保证它绝不吞掉落在自己身上的 drop。 */
.dsp-drag-hint{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1000;
  pointer-events:none;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:6px 14px;font-size:12px;
  box-shadow:0 6px 20px rgba(0,0,0,.18);}

/* 会话头部的小按钮：跟宿主 utilities 里的别的挂件同一个观感。 */
.dsp-head-btn{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;
  cursor:pointer;font-size:13px;line-height:1;padding:5px 8px;font-family:inherit;white-space:nowrap;}
.dsp-head-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.dsp-head-btn:disabled{opacity:.45;cursor:default;}
.dsp-switch{flex:0 0 auto;max-width:190px;border:.5px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  border-radius:6px;padding:4px 6px;font-size:12px;font-family:inherit;}

/* 打开会话过程中的提示 / 失败说明。只是浮在底部的一条，不再铺满整窗。 */
.dsp-notice{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;
  max-width:min(560px,84vw);display:flex;align-items:center;gap:10px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px;
  font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.2);}
.dsp-notice-error{color:var(--dsw-alias-state-error-primary);}
.dsp-notice-text{min-width:0;}
.dsp-trace{margin:0;padding:0;max-height:30vh;overflow:auto;white-space:pre-wrap;
  word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:11px;}
`;

        function Styles() {
          // data-dsp-keep：正常态返回的就是这个 <style>，它是浮层的直接子元素，
          // 不加标记会被上面那条「藏掉别人的浮层」规则命中。虽然浏览器对 <style>
          // 本来就不渲染、表照样生效，但没必要把成败押在这条实现细节上。
          return h('style', { 'data-dsh-session-popout': '', 'data-dsp-keep': '' }, CSS);
        }

        /* ------------------------------------------------------------------ *
         * 会话头部的窗口按钮
         *
         * 注册进 conversation.session.header.utilities（list 型、replaceRisk 无风险），
         * 于是它们和宿主的其它挂件排在同一行里，观感与原界面一致。
         * 两种角色共用同一个槽位；各自在不属于自己的窗口里渲染 null。
         * ------------------------------------------------------------------ */

        function ChildTools(props) {
          const { ctx } = props;
          const view = useIdentity();
          const rows = useSessionRows(ctx);
          if (view.role !== 'child' || !view.sessionId) return null;

          const sessionId = view.sessionId;
          const current = rows.find((row) => row.id === sessionId) || null;
          // 同一个项目（同 cwd）的其它会话。子级仍然是「一个会话一个窗口」，
          // 这里只留一个贴着标题的小下拉，方便原地换人看，不是母级那种侧栏列表。
          const cwd = current ? current.cwd : '';
          const siblings = cwd ? rows.filter((row) => row.cwd === cwd) : rows.slice(0, 20);

          const switchTo = (nextId) => {
            if (!nextId || nextId === sessionId) return;
            try {
              window.location.hash = `${HASH_CHILD}${encodeURIComponent(nextId)}`;
            } catch {
              /* hash 写不进去也不影响当前视图 */
            }
          };

          const recall = () => {
            // 先让宿主记住「该回到这个会话」，再关窗 —— 关窗之后就没机会发了。
            callHost(ROUTE_RECALL, { sessionId }).then(closeWindow, closeWindow);
          };

          return h(
            React.Fragment,
            null,
            h(Styles),
            siblings.length > 1
              ? h(
                  'select',
                  {
                    className: 'dsp-switch',
                    value: sessionId,
                    title: '同一个项目里的其它会话',
                    onChange: (event) => switchTo(event.target.value),
                  },
                  siblings.map((row) =>
                    h('option', { key: row.id, value: row.id }, row.title || row.id),
                  ),
                )
              : null,
            h(
              'button',
              {
                className: 'dsp-head-btn',
                type: 'button',
                title: '收回会话列表（关掉小窗，主窗口打开它）',
                onClick: recall,
              },
              '⇲ 收回',
            ),
          );
        }

        function GroupTools(props) {
          const { ctx } = props;
          const view = useIdentity();
          const rows = useSessionRows(ctx);
          if (view.role !== 'group') return null;

          const members = view.members;
          const groupId = view.groupId;
          const activeId = view.active || members[0] || '';

          const titleOf = (id) => {
            const row = rows.find((entry) => entry.id === id);
            return row ? row.title : String(id);
          };

          const writeActive = (nextActive) => {
            try {
              const search = new URLSearchParams();
              search.set('s', members.join(','));
              search.set('a', nextActive);
              window.location.hash = `${HASH_GROUP}${encodeURIComponent(groupId)}&${search.toString()}`;
            } catch {
              /* 写不进去就留在原会话 */
            }
          };

          const split = (sessionId) => {
            if (!sessionId) return;
            callHost(ROUTE_UNMERGE, { groupId, sessionId }).then(({ ok, body }) => {
              if (!ok || !body || body.ok === false) {
                window.alert(`拆不出去：${(body && (body.message || body.error)) || '宿主没有说明原因'}`);
                return;
              }
              if (body.emptied) closeWindow();
            });
          };

          const recall = () => {
            const target = activeId || members[0] || '';
            if (!target) {
              closeWindow();
              return;
            }
            callHost(ROUTE_RECALL, { sessionId: target }).then(closeWindow, closeWindow);
          };

          return h(
            React.Fragment,
            null,
            h(Styles),
            members.length > 1
              ? h(
                  'select',
                  {
                    className: 'dsp-switch',
                    value: activeId,
                    title: `这个集合里有 ${members.length} 个会话`,
                    onChange: (event) => writeActive(event.target.value),
                  },
                  members.map((id) =>
                    h('option', { key: id, value: id }, titleOf(id)),
                  ),
                )
              : null,
            h(
              'button',
              {
                className: 'dsp-head-btn',
                type: 'button',
                title: '把当前会话拆成独立窗口',
                disabled: !activeId,
                onClick: () => split(activeId),
              },
              '⇱ 拆分',
            ),
            h(
              'button',
              {
                className: 'dsp-head-btn',
                type: 'button',
                title: '收回会话列表（关掉这个窗口，主窗口打开当前会话）',
                onClick: recall,
              },
              '⇲ 收回',
            ),
          );
        }

        /* ------------------------------------------------------------------ *
         * 子窗控制器：让宿主把会话画出来 + 收掉导航栏 + 报打开状态
         *
         * 它挂在 shell.overlay 上，但不铺满视口 —— 正常时渲染 null，
         * 只有开不了会话时底部浮一条说明。
         * ------------------------------------------------------------------ */

        function PopoutController(props) {
          const { ctx } = props;
          const view = useIdentity();
          const state = useOpenState();
          const [attempt, setAttempt] = React.useState(0);

          useNativeCaption();
          React.useEffect(() => installShellCollapse(ctx), [ctx]);

          const target =
            view.role === 'group' ? view.active || view.members[0] || '' : view.sessionId;

          React.useEffect(() => {
            if (view.role === 'parent' || !target) return undefined;
            return openConversation(ctx, target);
          }, [ctx, target, view.role, attempt]);

          if (state.phase === 'waiting') {
            return h(
              'div',
              { className: 'dsp-notice', 'data-dsp-keep': '' },
              h(Styles, null),
              h('span', { className: 'dsp-notice-text' }, '正在打开会话…'),
            );
          }
          if (state.phase === 'error') {
            return h(
              'div',
              { className: 'dsp-notice dsp-notice-error', 'data-dsp-keep': '' },
              h(Styles, null),
              h('span', { className: 'dsp-notice-text' }, state.message),
              h(
                'button',
                {
                  className: 'dsp-head-btn',
                  type: 'button',
                  onClick: () => setAttempt((n) => n + 1),
                },
                '重试',
              ),
            );
          }
          // 正常时也挂一份 <style>，否则失败后才第一次出现样式会闪一下。
          return h(Styles, null);
        }

        /**
         * 渲染出错时的兜底。
         *
         * 没有它，任何一个组件抛异常都会被 React 整棵树卸载掉，用户得到的就是
         * 一片空白窗口 —— 既不知道出了什么事，也没法报告。这里把原因直接画出来，
         * 至少能一眼看出是「加载没完成」还是「代码抛了」。
         */
        class WindowBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: '' };
          }
          static getDerivedStateFromError(error) {
            return { error: (error && (error.stack || error.message)) || String(error) };
          }
          componentDidCatch(error) {
            // 同时报到窗口进程，管家 /health 里能读到，省得让用户复述。
            try {
              const bridge = window.__dshPopoutNative;
              if (bridge && typeof bridge.report === 'function') {
                bridge.report({ stage: 'render-error', error: String((error && error.message) || error) });
              }
            } catch {
              /* 报不上去也不影响把错误画出来 */
            }
          }
          render() {
            if (!this.state.error) return this.props.children;
            return h(
              'div',
              { className: 'dsp-notice dsp-notice-error', 'data-dsp-keep': '' },
              h(Styles, null),
              h(
                'div',
                { className: 'dsp-notice-text' },
                h('div', null, '窗口小工具出错（对话本身不受影响）：'),
                h('pre', { className: 'dsp-trace' }, this.state.error),
              ),
            );
          }
        }

        /* ------------------------------------------------------------------ *
         * 子窗自检（临时排障用，确认问题消失后可以整段删掉）
         *
         * 为什么需要：子窗是宿主页面的另一个实例。界面没画出来时，用户看到的
         * 就是「一片空白 + 壁纸」，而开发者既没有控制台也没有 devtools，
         * 只能靠猜。这里在窗口打开 3.5 秒后自己去查几个关键节点，
         * 查不到就把结论直接画在页面上 —— 用纯 DOM 画，不经过 React、也不经过
         * 槽位，所以连「整个界面根本没挂载」这种情况也能报出来。
         * ------------------------------------------------------------------ */

        const bootErrors = [];

        function watchBootErrors() {
          try {
            window.addEventListener(
              'error',
              (event) => {
                const message =
                  (event && (event.message || (event.error && event.error.message))) || '';
                if (!message) return;
                bootErrors.push('error: ' + message);
                if (bootErrors.length > 6) bootErrors.shift();
              },
              true,
            );
            window.addEventListener('unhandledrejection', (event) => {
              const reason = event && event.reason;
              const message = (reason && (reason.message || String(reason))) || '';
              if (!message) return;
              bootErrors.push('reject: ' + message);
              if (bootErrors.length > 6) bootErrors.shift();
            });
          } catch {
            /* 装不上监听就少一条线索，不影响自检本身 */
          }
        }

        /** 会话区到底有没有被宿主画出来。查询本身失败时按「有」处理，免得误报。 */
        function hasConversationDom() {
          try {
            return Boolean(
              document.querySelector(
                '[class*=ConversationRoot],[data-conversation-scroll],[data-chat-flow],[data-composer-card],[data-pane=conversation]',
              ),
            );
          } catch {
            return true;
          }
        }

        function describeShell(ctx) {
          const lines = [];
          const add = (key, value) => lines.push(key + '：' + value);
          try {
            add('hash', location.hash || '(空)');
          } catch {
            add('hash', '读不到');
          }
          try {
            add('标题', document.title || '(空)');
          } catch {
            add('标题', '读不到');
          }
          const frame = shellFrame();
          add('外框 frame', frame ? '有' : '没有');
          if (frame) {
            add('侧栏', frame.hasAttribute('data-sidebar-collapsed') ? '已收起' : '还在');
            add('右栏', frame.hasAttribute('data-rightbar-collapsed') ? '已收起' : '还在');
            add('frame 子节点', String(frame.children.length));
          }
          try {
            const overlay = document.querySelector('[data-shell-overlay]');
            add('浮层', overlay ? '有，子项 ' + overlay.children.length : '没有');
          } catch {
            add('浮层', '读不到');
          }
          add('会话区 DOM', hasConversationDom() ? '有' : '没有');
          try {
            const snapshot = ctx.sessions.list.getSnapshot();
            const phase = snapshot && snapshot.phase;
            const ids = (snapshot && snapshot.ids) || [];
            add('会话目录', String(phase) + '，' + ids.length + ' 条');
          } catch (error) {
            add('会话目录', '读不到：' + messageOf(error));
          }
          add('打开状态', openState.phase + (openState.message ? '：' + openState.message : ''));
          try {
            add('主题', document.body.hasAttribute('data-ds-dark-theme') ? '暗色' : '亮色');
          } catch {
            /* 没皮肤只是少一行信息 */
          }
          if (bootErrors.length) {
            lines.push('--- 启动期错误 ---');
            for (const line of bootErrors) lines.push(line);
          }
          return lines;
        }

        function startSelfCheck(ctx) {
          let box = null;
          const report = () => {
            // 慢机子上 3.5 秒可能还不够，所以多试几次；一旦会话区出现就收工。
            if (hasConversationDom()) {
              if (box !== null) {
                box.remove();
                box = null;
              }
              return true;
            }
            if (box !== null) return false;
            try {
              box = document.createElement('div');
              box.setAttribute('data-dsp-keep', '');
              box.style.cssText = [
                'position:fixed',
                'left:14px',
                'right:14px',
                'bottom:14px',
                'z-index:2147483647',
                'box-sizing:border-box',
                'max-height:70vh',
                'overflow:auto',
                'padding:12px 14px',
                'border-radius:10px',
                'border:1px solid #d97070',
                'background:#171a20f2',
                'color:#e9edf6',
                'font:12px/1.6 ui-monospace,Consolas,monospace',
                'white-space:pre-wrap',
                'word-break:break-all',
                'box-shadow:0 12px 32px #00000080',
              ].join(';');
              const head = document.createElement('div');
              head.textContent = '子窗自检：宿主界面没有画出来（把这块截图发给开发者就行）';
              head.style.cssText = 'font-weight:700;margin-bottom:8px;color:#ffd9a1';
              const bodyText = document.createElement('div');
              bodyText.textContent = describeShell(ctx).join('\n');
              const bar = document.createElement('div');
              bar.style.cssText = 'margin-top:10px';
              const close = document.createElement('button');
              close.type = 'button';
              close.textContent = '关掉这块';
              close.style.cssText =
                'cursor:pointer;font:inherit;color:#e9edf6;background:#2a3040;border:1px solid #4a5266;border-radius:6px;padding:4px 10px';
              close.addEventListener('click', () => {
                if (box !== null) box.remove();
                box = null;
              });
              bar.appendChild(close);
              box.appendChild(head);
              box.appendChild(bodyText);
              box.appendChild(bar);
              document.body.appendChild(box);
              // 同时报给窗口管家，开着窗口时 /health 里能读到同一份结论。
              try {
                const bridge = window.__dshPopoutNative;
                if (bridge && typeof bridge.report === 'function') {
                  bridge.report({ stage: 'self-check', detail: describeShell(ctx).join(' | ') });
                }
              } catch {
                /* 报不上去不影响屏幕上的那份 */
              }
            } catch {
              /* 连自检都画不出来就只能作罢，别把界面再搞坏一次 */
            }
            return false;
          };

          const timers = [];
          for (const delay of [3500, 8000, 15000]) {
            timers.push(setTimeout(() => report(), delay));
          }
          return () => {
            for (const timer of timers) clearTimeout(timer);
            if (box !== null) {
              box.remove();
              box = null;
            }
          };
        }

        /* ------------------------------------------------------------------ *
         * 装配
         * ------------------------------------------------------------------ */

        function apply(ctx) {
          const identity = readIdentity();

          if (identity.role !== 'parent') {
            // 弹窗：不再自绘界面，也不再铺满整窗。
            // 打上标记让 CSS 收拾别人的浮层，剩下的交给宿主自己渲染。
            try {
              document.documentElement.dataset.dshPopout = '';
            } catch {
              /* 打不上标记最多是多几个浮块，不影响对话本身 */
            }

            // 自检：只在「宿主界面真的没画出来」时才在页面底部摆一块说明。
            // 界面正常时它什么都不做，只是安静计时到点就退出。
            watchBootErrors();
            try {
              ctx.effect(() => startSelfCheck(ctx), 'dsh-session-popout: 子窗自检');
            } catch {
              startSelfCheck(ctx);
            }

            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                { name: 'shell.overlay', id: 'dsh-session-popout:popout', order: 100000 },
                () => h(WindowBoundary, null, h(PopoutController, { ctx })),
              ),
            );

            // 会话头部的窗口按钮。order 给 60，排在宿主自己的挂件之后、最右侧一类的位置。
            ctx.slots.inject('conversation.session.header.utilities', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.utilities',
                  id: 'dsh-session-popout:child-tools',
                  order: 60,
                  label: () => '小窗操作',
                },
                () => h(ChildTools, { ctx }),
              ),
            );
            ctx.slots.inject('conversation.session.header.utilities', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.utilities',
                  id: 'dsh-session-popout:group-tools',
                  order: 61,
                  label: () => '集合窗操作',
                },
                () => h(GroupTools, { ctx }),
              ),
            );
            return;
          }

          // 母级：听侧栏的拖拽 + 接住子级/集合窗口发来的「收回」。
          ctx.effect(() => installDragOut(), 'dsh-session-popout: 拖拽开窗');

          // 拖动过程中的提示条。挂全局浮层而不是侧栏里，
          // 免得被侧栏那条窄容器裁掉（侧栏 overflow:hidden）。
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-session-popout:hint', order: 950 },
              DragHint,
            ),
          );

          // 子级/集合窗口点「收回」→ 主窗切到那个会话。
          // 两者不同源（弹窗是 http://127.0.0.1:<port>，主窗是 dsh-app://app），
          // BroadcastChannel / localStorage 都跨不过去，所以借宿主路由转一手。
          ctx.effect(() => {
            let stopped = false;
            let timer = null;
            let cancelOpen = null;
            const poll = () => {
              if (stopped || !popoutOpenedOnce) return;
              // 主窗在后台时不打扰宿主：用户切回来会立刻轮询一次。
              if (typeof document !== 'undefined' && document.hidden) return;
              callHost(ROUTE_TAKE_RECALL).then(({ ok, body }) => {
                if (stopped || !ok || !body || !body.sessionId) return;
                try {
                  if (cancelOpen) cancelOpen();
                  // 母窗的会话目录也未必 ready（刚启动时同样会 pending），走同一套等待。
                  cancelOpen = openConversation(ctx, body.sessionId);
                  window.focus();
                } catch {
                  /* 切不过去就只是没跳转，不影响其它功能 */
                }
              });
            };
            timer = setInterval(poll, RECALL_POLL_MS);
            const onVisible = () => {
              if (!document.hidden) poll();
            };
            document.addEventListener('visibilitychange', onVisible);
            poll();
            return () => {
              stopped = true;
              if (timer !== null) clearInterval(timer);
              if (cancelOpen) cancelOpen();
              document.removeEventListener('visibilitychange', onVisible);
            };
          }, 'dsh-session-popout: 收回轮询');
        }

        // 必须把用到的服务全声明出来。Cordis 只把 inject 里列过的服务挂到 ctx 上，
        // 漏声明不会在加载时报错，只会在真正用到的那一刻给出 undefined ——
        // 表现是窗口整片空白，而异常发生在 React 渲染函数里，从外面完全看不出因果。
        // slots 注册浮层与头部按钮；sessions 读会话目录；uiWorkspace 让宿主显示会话；
        // layout 把子窗的左侧导航栏收起来。
        return { inject: ['slots', 'sessions', 'uiWorkspace', 'layout'], apply };
      },
    });
  } catch {
    /* 半侧加载失败不该拖垮整个界面 */
  }
})();
