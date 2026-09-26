/**
 * Super X - Page Bridge (Runs in MAIN world at document_start)
 *
 * Responsibilities:
 * 1. In the right-side detail iframe (`window.name === 'superx-detail-iframe'`):
 *    - Hooks into X's React Router `history` object and `popstate` listeners
 *      to enable instant (<50ms) SPA switching between tweets without full iframe reloads.
 *    - Tracks internal navigation depth so the back button knows whether to go back
 *      inside the iframe or close the detail panel.
 * 2. In the parent timeline window (`window.top`):
 *    - Extracts tweet status URLs from React Fiber when clicking quoted tweets that lack DOM `<a>` tags.
 *    - Guards the parent React Router `history.push` so clicking a tweet card in the list
 *      never navigates the main timeline away.
 */
(function () {
  'use strict';

  const IS_DETAIL_IFRAME =
    window.self !== window.top && window.name === 'superx-detail-iframe';

  const STATUS_PATH_REGEX = /^\/(?:[^/]+|i)\/status\/(\d+)\/?(?:\?.*)?$/;
  const NON_DETAIL_STATUS_SUFFIX =
    /\/status\/\d+\/(?:photo|video|retweets|quotes|likes|bookmarks|analytics|media_tags|hidden)/;

  function isPureStatusPath(pathOrUrl) {
    try {
      const u = new URL(pathOrUrl, window.location.origin);
      if (NON_DETAIL_STATUS_SUFFIX.test(u.pathname)) return false;
      return STATUS_PATH_REGEX.test(u.pathname);
    } catch {
      return false;
    }
  }

  function extractStatusId(pathOrUrl) {
    try {
      const u = new URL(pathOrUrl, window.location.origin);
      const m = u.pathname.match(STATUS_PATH_REGEX);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // Capture popstate listeners registered by X's history package
  const popstateListeners = new Set();
  const origAddEventListener = window.addEventListener;
  const origRemoveEventListener = window.removeEventListener;

  window.addEventListener = function (type, listener, options) {
    if (type === 'popstate' && typeof listener === 'function') {
      popstateListeners.add(listener);
    }
    return origAddEventListener.call(this, type, listener, options);
  };

  window.removeEventListener = function (type, listener, options) {
    if (type === 'popstate' && typeof listener === 'function') {
      popstateListeners.delete(listener);
    }
    return origRemoveEventListener.call(this, type, listener, options);
  };

  let cachedRouterHistory = null;

  /**
   * Locate X's internal `history` object (from `createBrowserHistory`) via React Fiber tree
   */
  function findRouterHistory() {
    if (
      cachedRouterHistory &&
      typeof cachedRouterHistory.push === 'function' &&
      typeof cachedRouterHistory.replace === 'function'
    ) {
      return cachedRouterHistory;
    }

    const root = document.getElementById('react-root');
    if (!root) return null;

    let rootFiber = null;
    const keys = Object.keys(root);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.startsWith('__reactContainer$') || k.startsWith('_reactRootContainer')) {
        const val = root[k];
        rootFiber = val?._internalRoot?.current || val?.current || val;
        break;
      }
    }

    if (!rootFiber && root.firstElementChild) {
      const childKeys = Object.keys(root.firstElementChild);
      for (let i = 0; i < childKeys.length; i++) {
        if (childKeys[i].startsWith('__reactFiber$')) {
          let f = root.firstElementChild[childKeys[i]];
          while (f && f.return) f = f.return;
          rootFiber = f;
          break;
        }
      }
    }

    if (!rootFiber) return null;

    const queue = [rootFiber];
    let visited = 0;

    while (queue.length > 0 && visited < 400) {
      const node = queue.shift();
      visited++;
      if (!node) continue;

      const candidates = [
        node.memoizedProps?.history,
        node.memoizedProps?.value?.history,
        node.memoizedProps?.navigation,
        node.stateNode?.history,
        node.memoizedState?.memoizedState?.history
      ];

      for (let i = 0; i < candidates.length; i++) {
        const h = candidates[i];
        if (
          h &&
          typeof h.push === 'function' &&
          typeof h.replace === 'function' &&
          h.location
        ) {
          cachedRouterHistory = h;
          return h;
        }
      }

      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }

    return null;
  }

  /**
   * Extract status URL or tweet ID from a DOM element's React Fiber (useful for Quoted Tweets)
   */
  function extractStatusUrlFromFiber(domElement, stopAtElement) {
    let curr = domElement;
    while (curr && curr !== stopAtElement && curr !== document.body) {
      const fiberKey = Object.keys(curr).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')
      );
      if (fiberKey) {
        let fiber = curr[fiberKey];
        let depth = 0;
        while (fiber && depth < 25) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props) {
            // Check direct tweet / quoted tweet objects in props
            const tweetObj =
              props.quotedTweet ||
              props.quoted_status ||
              props.quotedStatus ||
              props.tweet ||
              props.status ||
              props.item;
            if (tweetObj && typeof tweetObj === 'object') {
              const id =
                tweetObj.rest_id ||
                tweetObj.id_str ||
                tweetObj.id ||
                tweetObj.legacy?.id_str;
              const screenName =
                tweetObj.core?.user_results?.result?.legacy?.screen_name ||
                tweetObj.user?.screen_name ||
                tweetObj.author?.screen_name ||
                tweetObj.legacy?.screen_name;
              if (id && /^\d{10,25}$/.test(String(id))) {
                return screenName
                  ? `/${screenName}/status/${id}`
                  : `/i/status/${id}`;
              }
            }
            if (
              props.tweetId &&
              /^\d{10,25}$/.test(String(props.tweetId))
            ) {
              return `/i/status/${props.tweetId}`;
            }
          }
          fiber = fiber.return;
          depth++;
        }
      }
      curr = curr.parentElement;
    }
    return null;
  }

  // =========================================================================
  // MODE 1: Inside the Right-Side Detail Iframe
  // =========================================================================
  if (IS_DETAIL_IFRAME) {
    let navDepth = 0;
    let isProgrammaticNav = false;

    const origPushState = window.history.pushState;
    const origReplaceState = window.history.replaceState;

    function notifyParentOfUrl() {
      window.parent.postMessage(
        {
          type: 'SUPERX_IFRAME_STATE',
          url: window.location.href,
          pathname: window.location.pathname,
          navDepth
        },
        '*'
      );
    }

    window.history.pushState = function (state, title, url) {
      const res = origPushState.apply(this, arguments);
      if (!isProgrammaticNav) {
        navDepth++;
      }
      notifyParentOfUrl();
      return res;
    };

    window.history.replaceState = function (state, title, url) {
      const res = origReplaceState.apply(this, arguments);
      notifyParentOfUrl();
      return res;
    };

    window.addEventListener('popstate', () => {
      if (!isProgrammaticNav && navDepth > 0) {
        navDepth--;
      }
      notifyParentOfUrl();
    });

    function navigateIframeTo(targetUrl) {
      try {
        const parsed = new URL(targetUrl, window.location.origin);
        const targetPath = parsed.pathname + parsed.search + parsed.hash;

        isProgrammaticNav = true;
        navDepth = 0;

        const routerHistory = findRouterHistory();
        if (routerHistory) {
          routerHistory.push(targetPath);
        } else {
          const stateObj = {
            key: Math.random().toString(36).slice(2, 8),
            state: { fromSuperX: true }
          };
          origPushState.call(window.history, stateObj, '', targetPath);
          const popEvent = new PopStateEvent('popstate', { state: stateObj });
          window.dispatchEvent(popEvent);
        }

        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        isProgrammaticNav = false;
        notifyParentOfUrl();

        // Notify parent that navigation has been dispatched
        window.parent.postMessage(
          {
            type: 'SUPERX_IFRAME_NAV_DONE',
            url: parsed.href,
            pathname: parsed.pathname
          },
          '*'
        );
      } catch (err) {
        isProgrammaticNav = false;
        window.location.replace(targetUrl);
      }
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'SUPERX_IFRAME_NAVIGATE' && data.url) {
        navigateIframeTo(data.url);
      } else if (data.type === 'SUPERX_IFRAME_PAUSE_MEDIA') {
        document.querySelectorAll('video, audio').forEach((media) => {
          try {
            media.pause();
          } catch (_) {}
        });
      } else if (data.type === 'SUPERX_IFRAME_GO_BACK') {
        if (navDepth > 0) {
          window.history.back();
        } else {
          window.parent.postMessage({ type: 'SUPERX_CLOSE_PANEL' }, '*');
        }
      }
    });

    // Intercept clicks on X's top-left back button `[data-testid="app-bar-back"]` inside the iframe
    window.addEventListener(
      'click',
      (event) => {
        const backBtn =
          event.target &&
          typeof event.target.closest === 'function'
            ? event.target.closest('[data-testid="app-bar-back"]')
            : null;
        if (backBtn && navDepth <= 0) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          window.parent.postMessage({ type: 'SUPERX_CLOSE_PANEL' }, '*');
        }
      },
      true
    );

    // Let parent know once React root has mounted inside the iframe
    const readyCheck = setInterval(() => {
      const root = document.getElementById('react-root');
      if (root && root.querySelector('main, [data-testid="primaryColumn"]')) {
        clearInterval(readyCheck);
        findRouterHistory();
        window.parent.postMessage(
          {
            type: 'SUPERX_IFRAME_READY',
            url: window.location.href
          },
          '*'
        );
      }
    }, 100);

    return;
  }

  // =========================================================================
  // MODE 2: Inside the Parent Window (window.top)
  // =========================================================================
  let lastPrimaryColumnClickTs = 0;

  // Listen in capture phase to assist with Quoted Tweet Fiber extraction
  window.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('[data-testid="primaryColumn"] article[data-testid="tweet"]')) {
        lastPrimaryColumnClickTs = Date.now();
      }
    },
    true
  );

  // Expose helper via custom DOM attribute / event for content.js when clicking Quoted Tweets
  window.addEventListener(
    'click',
    (event) => {
      if (document.documentElement.dataset.superxEnabled === 'false') return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const article = target.closest(
        '[data-testid="primaryColumn"] article[data-testid="tweet"]'
      );
      if (!article) return;

      // Check if click is inside a quoted tweet container (`div[role="link"]`) inside the article
      const quoteCard = target.closest('div[role="link"]');
      if (quoteCard && article.contains(quoteCard)) {
        const fiberUrl = extractStatusUrlFromFiber(target, article);
        if (fiberUrl) {
          quoteCard.setAttribute('data-superx-quote-url', fiberUrl);
        }
      }
    },
    true
  );

  // Hook parent router history.push to catch any React-driven status navigation from primaryColumn
  function installParentHistoryGuard() {
    const routerHistory = findRouterHistory();
    if (!routerHistory || routerHistory.__superxGuarded) return;

    const origPush = routerHistory.push;
    routerHistory.push = function (path, state) {
      if (document.documentElement.dataset.superxEnabled !== 'false') {
        const targetStr =
          typeof path === 'string'
            ? path
            : path && typeof path.pathname === 'string'
            ? path.pathname + (path.search || '')
            : '';

        const isRecentTweetClick = Date.now() - lastPrimaryColumnClickTs < 800;
        const onStatusPageAlready = isPureStatusPath(window.location.pathname);

        if (
          isRecentTweetClick &&
          !onStatusPageAlready &&
          targetStr &&
          isPureStatusPath(targetStr)
        ) {
          const statusId = extractStatusId(targetStr);
          window.postMessage(
            {
              type: 'SUPERX_OPEN_FROM_ROUTER_GUARD',
              url: new URL(targetStr, window.location.origin).href,
              statusId
            },
            '*'
          );
          return;
        }
      }
      return origPush.apply(this, arguments);
    };
    routerHistory.__superxGuarded = true;
  }

  const guardTimer = setInterval(() => {
    installParentHistoryGuard();
    if (cachedRouterHistory && cachedRouterHistory.__superxGuarded) {
      clearInterval(guardTimer);
    }
  }, 500);
})();
