/**
 * Super X - Content Script (ISOLATED world, runs at document_start in all frames)
 *
 * When clicking a tweet card on X (Twitter) timeline/list, opens the tweet detail
 * and replies in the right-side panel instead of navigating the main page away.
 */
(function () {
  'use strict';

  const IS_DETAIL_IFRAME =
    window.self !== window.top && window.name === 'superx-detail-iframe';

  // =========================================================================
  // 1. IFRAME MODE: Inside the Right-Side Detail Panel Iframe
  // =========================================================================
  if (IS_DETAIL_IFRAME) {
    // Immediately apply iframe class at document_start so sidebar/nav never flash
    document.documentElement.classList.add('superx-iframe-mode');

    let lastModalOpen = false;
    function checkIframeModalState() {
      const hasDialog = Boolean(
        document.querySelector(
          '#layers [role="dialog"], #layers [data-testid="swipe-to-dismiss"], #layers [aria-modal="true"]'
        ) || /\/status\/\d+\/(?:photo|video)\//.test(window.location.pathname)
      );
      if (hasDialog !== lastModalOpen) {
        lastModalOpen = hasDialog;
        window.parent.postMessage(
          { type: 'SUPERX_IFRAME_MODAL_STATE', open: hasDialog },
          '*'
        );
      }
    }

    const startIframeObserver = () => {
      checkIframeModalState();
      if (document.body) {
        new MutationObserver(checkIframeModalState).observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startIframeObserver);
    } else {
      startIframeObserver();
    }

    // Sync theme background and watch Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Only close the panel if no modal/lightbox is open inside the iframe
        const hasOpenModal = document.querySelector(
          '#layers [role="dialog"], #layers [data-testid="mask"], #layers [data-testid="swipe-to-dismiss"]'
        );
        if (!hasOpenModal && !lastModalOpen) {
          window.parent.postMessage({ type: 'SUPERX_CLOSE_PANEL' }, '*');
        }
      }
    });

    return;
  }

  // Only run parent logic in top window
  if (window.self !== window.top) return;

  // =========================================================================
  // 2. PARENT WINDOW MODE: Timeline Click Interception & Split Panel Management
  // =========================================================================

  const STATUS_PATH_REGEX = /^\/(?:[^/]+|i)\/status\/(\d+)\/?(?:\?.*)?$/;
  const NON_DETAIL_STATUS_SUFFIX =
    /\/status\/\d+\/(?:photo|video|retweets|quotes|likes|bookmarks|analytics|media_tags|hidden)/;

  let settings = {
    enabled: true,
    customWidth: 0 // 0 = auto fill right area
  };

  let panelEl = null;
  let iframeEl = null;
  let loadingOverlayEl = null;
  let progressBarEl = null;
  let openTabBtnEl = null;
  let activeStyleEl = null;

  let isPanelOpen = false;
  let isIframeReady = false;
  let isIframeBooted = false;
  let currentStatusUrl = '';
  let currentStatusId = '';
  let pendingNavigateUrl = null;
  let progressTimeout = null;

  // Load saved settings
  function loadSettings() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['superx_enabled', 'superx_width'], (res) => {
          if (typeof res.superx_enabled === 'boolean') {
            settings.enabled = res.superx_enabled;
          }
          if (typeof res.superx_width === 'number' && res.superx_width >= 360) {
            settings.customWidth = res.superx_width;
          }
          syncEnabledState();
        });

        chrome.storage.onChanged.addListener((changes) => {
          if (changes.superx_enabled) {
            settings.enabled = changes.superx_enabled.newValue !== false;
            syncEnabledState();
          }
          if (changes.superx_width) {
            settings.customWidth = changes.superx_width.newValue || 0;
            updatePanelGeometry();
          }
        });
      }
    } catch (_) {}
  }

  function syncEnabledState() {
    document.documentElement.dataset.superxEnabled = settings.enabled ? 'true' : 'false';
    if (!settings.enabled && isPanelOpen) {
      closePanel();
    }
  }

  loadSettings();
  syncEnabledState();

  function isPureStatusUrl(urlStr) {
    try {
      const u = new URL(urlStr, window.location.origin);
      if (u.origin !== window.location.origin) return false;
      if (NON_DETAIL_STATUS_SUFFIX.test(u.pathname)) return false;
      return STATUS_PATH_REGEX.test(u.pathname);
    } catch {
      return false;
    }
  }

  function extractStatusId(urlStr) {
    try {
      const u = new URL(urlStr, window.location.origin);
      const m = u.pathname.match(STATUS_PATH_REGEX);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Detect current X theme (Light / Dim / Dark) from body styles and apply to panel
   */
  function syncThemeFromPage() {
    if (!panelEl || !document.body) return;
    const bg = window.getComputedStyle(document.body).backgroundColor;
    if (!bg) return;

    panelEl.style.setProperty('--superx-bg', bg);

    // Determine if dark/dim or light mode by RGB luminance
    const match = bg.match(/\d+/g);
    if (match && match.length >= 3) {
      const r = Number(match[0]);
      const g = Number(match[1]);
      const b = Number(match[2]);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const isDark = luminance < 0.5;
      panelEl.classList.toggle('superx-theme-dark', isDark);
      panelEl.classList.toggle('superx-theme-light', !isDark);
      document.documentElement.classList.toggle('superx-theme-dark', isDark);
    }
  }

  /**
   * Highlight the active tweet card in the left timeline list
   */
  function setActiveTweetHighlight(statusId) {
    currentStatusId = statusId || '';
    if (!activeStyleEl) {
      activeStyleEl = document.createElement('style');
      activeStyleEl.id = 'superx-active-tweet-style';
      (document.head || document.documentElement).appendChild(activeStyleEl);
    }

    if (!currentStatusId) {
      activeStyleEl.textContent = '';
      return;
    }

    // Highlight the tweet whose header User-Name timestamp matches currentStatusId
    activeStyleEl.textContent = `
      [data-testid="primaryColumn"] article[data-testid="tweet"]:has([data-testid="User-Name"] a[href*="/status/${currentStatusId}"]) {
        background-color: rgba(29, 155, 240, 0.065) !important;
        box-shadow: inset 3.5px 0 0 0 rgb(29, 155, 240), inset 0 0 0 1px rgba(29, 155, 240, 0.28) !important;
        transition: background-color 0.15s ease, box-shadow 0.15s ease;
      }
    `;
  }

  /**
   * Create the Right-Side Detail Panel DOM
   */
  function ensurePanelCreated() {
    if (panelEl) return panelEl;
    if (!document.body) return null;

    panelEl = document.createElement('aside');
    panelEl.id = 'superx-detail-panel';
    panelEl.className = 'superx-panel superx-panel-closed superx-theme-light';
    panelEl.setAttribute('aria-label', '帖子详情分栏');

    panelEl.innerHTML = `
      <div class="superx-resize-handle" title="左右拖动调整详情栏宽度 (双击重置)"></div>
      <div class="superx-progress-bar"></div>
      <div class="superx-floating-toolbar">
        <button type="button" class="superx-tool-btn" data-action="open-tab" title="在新标签页中打开此帖">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
          </svg>
        </button>
        <button type="button" class="superx-tool-btn" data-action="close" title="关闭详情栏 (Esc)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"/>
          </svg>
        </button>
      </div>
      <div class="superx-loading-overlay">
        <div class="superx-spinner"></div>
      </div>
      <iframe
        name="superx-detail-iframe"
        class="superx-iframe"
        allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
      ></iframe>
    `;

    document.body.appendChild(panelEl);

    iframeEl = panelEl.querySelector('.superx-iframe');
    loadingOverlayEl = panelEl.querySelector('.superx-loading-overlay');
    progressBarEl = panelEl.querySelector('.superx-progress-bar');
    openTabBtnEl = panelEl.querySelector('[data-action="open-tab"]');
    const closeBtnEl = panelEl.querySelector('[data-action="close"]');
    const resizeHandleEl = panelEl.querySelector('.superx-resize-handle');

    openTabBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentStatusUrl) {
        window.open(currentStatusUrl, '_blank', 'noopener');
      }
    });

    closeBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      closePanel();
    });

    setupResizeHandle(resizeHandleEl);
    syncThemeFromPage();
    updatePanelGeometry();

    return panelEl;
  }

  /**
   * Allow dragging the left border of the panel to customize its width
   */
  function setupResizeHandle(handleEl) {
    let isDragging = false;

    handleEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      isDragging = true;
      panelEl.classList.add('superx-resizing');
    });

    handleEl.addEventListener('dblclick', () => {
      settings.customWidth = 0;
      try {
        chrome.storage?.local?.set({ superx_width: 0 });
      } catch (_) {}
      updatePanelGeometry();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
      if (!primaryColumn) return;
      const rect = primaryColumn.getBoundingClientRect();
      const maxWidth = Math.max(400, document.documentElement.clientWidth - rect.right);
      const desiredWidth = Math.min(maxWidth, Math.max(360, e.clientX - rect.right));
      settings.customWidth = Math.round(desiredWidth);
      updatePanelGeometry();
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      if (panelEl) panelEl.classList.remove('superx-resizing');
      if (settings.customWidth > 0) {
        try {
          chrome.storage?.local?.set({ superx_width: settings.customWidth });
        } catch (_) {}
      }
    });
  }

  /**
   * Align the right panel flush with the right edge of `[data-testid="primaryColumn"]`
   * covering the right column area (as shown in Image 1).
   */
  function updatePanelGeometry() {
    if (!panelEl) return;

    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    const viewportWidth = document.documentElement.clientWidth;

    if (!primaryColumn) {
      return;
    }

    const rect = primaryColumn.getBoundingClientRect();
    const leftEdge = Math.round(rect.right);
    const availableRightWidth = Math.max(0, viewportWidth - leftEdge);

    if (availableRightWidth < 280) {
      // Viewport is too narrow for side-by-side split, overlay gracefully on the right side
      const fallbackWidth = Math.min(540, Math.round(viewportWidth * 0.52));
      panelEl.style.left = `${viewportWidth - fallbackWidth}px`;
      panelEl.style.width = `${fallbackWidth}px`;
      return;
    }

    let panelWidth = availableRightWidth;
    if (settings.customWidth >= 360) {
      panelWidth = Math.min(availableRightWidth, settings.customWidth);
    } else {
      // Fill the right column area comfortably (cap at 680px on ultra-wide monitors so text remains readable)
      panelWidth = Math.min(680, availableRightWidth);
    }

    panelEl.style.left = `${leftEdge}px`;
    panelEl.style.width = `${panelWidth}px`;
  }

  /**
   * Pre-warm the iframe in the background so even the very first tweet click opens instantaneously
   */
  function prewarmIframeIfNeeded() {
    if (!settings.enabled || isIframeBooted) return;
    if (!document.querySelector('[data-testid="primaryColumn"]')) return;

    const panel = ensurePanelCreated();
    if (!panel || !iframeEl) return;

    isIframeBooted = true;
    // Load a lightweight static route on x.com so X's React Router & GraphQL client boot silently
    iframeEl.src = `${window.location.origin}/i/keyboard_shortcuts`;
  }

  function triggerProgressAnimation() {
    if (!progressBarEl) return;
    clearTimeout(progressTimeout);
    progressBarEl.classList.remove('superx-progress-done');
    progressBarEl.classList.add('superx-progress-active');
    progressTimeout = setTimeout(() => {
      if (!progressBarEl) return;
      progressBarEl.classList.remove('superx-progress-active');
      progressBarEl.classList.add('superx-progress-done');
      setTimeout(() => {
        if (progressBarEl) progressBarEl.classList.remove('superx-progress-done');
      }, 250);
    }, 380);
  }

  /**
   * Open or update the right-side detail panel with the given tweet status URL
   */
  function openStatusInPanel(targetUrl, statusId) {
    if (!settings.enabled) return;

    const normalizedUrl = new URL(targetUrl, window.location.origin).href;
    const extractedId = statusId || extractStatusId(normalizedUrl);

    const panel = ensurePanelCreated();
    if (!panel || !iframeEl) return;

    syncThemeFromPage();

    // Mark split view active BEFORE measuring geometry so layout adjustments apply immediately
    isPanelOpen = true;
    document.documentElement.classList.add('superx-split-active');
    panel.classList.remove('superx-panel-closed');
    panel.classList.add('superx-panel-open');

    updatePanelGeometry();
    requestAnimationFrame(updatePanelGeometry);

    setActiveTweetHighlight(extractedId);
    currentStatusUrl = normalizedUrl;

    if (!isIframeBooted) {
      // First click happened before background prewarm ran: load the status URL directly
      isIframeBooted = true;
      loadingOverlayEl.classList.remove('superx-hidden');
      iframeEl.src = normalizedUrl;
      return;
    }

    if (!isIframeReady) {
      // Prewarm is mid-flight: queue the URL or load directly
      loadingOverlayEl.classList.remove('superx-hidden');
      pendingNavigateUrl = normalizedUrl;
      iframeEl.src = normalizedUrl;
      return;
    }

    // Iframe React Router is already warm & ready -> Instant SPA Navigation!
    loadingOverlayEl.classList.add('superx-hidden');
    triggerProgressAnimation();

    iframeEl.contentWindow.postMessage(
      {
        type: 'SUPERX_IFRAME_NAVIGATE',
        url: normalizedUrl,
        statusId: extractedId
      },
      '*'
    );
  }

  /**
   * Close/hide the right-side detail panel (keeps iframe warm for instant next open)
   */
  function closePanel() {
    if (!panelEl) return;
    isPanelOpen = false;
    document.documentElement.classList.remove('superx-split-active');
    panelEl.classList.remove('superx-panel-open');
    panelEl.classList.add('superx-panel-closed');
    setActiveTweetHighlight('');

    if (iframeEl && iframeEl.contentWindow) {
      iframeEl.contentWindow.postMessage({ type: 'SUPERX_IFRAME_PAUSE_MEDIA' }, '*');
    }
  }

  // Listen for messages from the iframe & MAIN world bridge
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'SUPERX_IFRAME_READY') {
      isIframeReady = true;
      if (pendingNavigateUrl) {
        const urlToOpen = pendingNavigateUrl;
        pendingNavigateUrl = null;
        if (iframeEl && iframeEl.contentWindow) {
          iframeEl.contentWindow.postMessage(
            {
              type: 'SUPERX_IFRAME_NAVIGATE',
              url: urlToOpen
            },
            '*'
          );
        }
      }
      if (loadingOverlayEl && isPanelOpen) {
        loadingOverlayEl.classList.add('superx-hidden');
      }
    } else if (data.type === 'SUPERX_IFRAME_STATE' && data.url) {
      if (isPureStatusUrl(data.url)) {
        currentStatusUrl = data.url;
        if (loadingOverlayEl) {
          loadingOverlayEl.classList.add('superx-hidden');
        }
      }
    } else if (data.type === 'SUPERX_IFRAME_NAV_DONE') {
      if (loadingOverlayEl) {
        loadingOverlayEl.classList.add('superx-hidden');
      }
    } else if (data.type === 'SUPERX_CLOSE_PANEL') {
      closePanel();
    } else if (data.type === 'SUPERX_OPEN_FROM_ROUTER_GUARD' && data.url) {
      openStatusInPanel(data.url, data.statusId);
    } else if (data.type === 'SUPERX_IFRAME_MODAL_STATE') {
      if (panelEl) {
        panelEl.classList.toggle('superx-iframe-modal-open', Boolean(data.open));
      }
    }
  });

  // =========================================================================
  // 3. CLICK INTERCEPTION ON TIMELINE TWEET CARDS
  // =========================================================================

  /**
   * Determine if the clicked target inside an `article[data-testid="tweet"]` is an interactive
   * button/media/profile/external link that should preserve its native behavior.
   */
  function shouldAllowNativeInteraction(target, article) {
    // 1. Action buttons (Reply, Retweet, Like, Bookmark, Share, More Caret, Grok, Follow, Poll)
    const buttonLike = target.closest(
      'button, [role="button"], [data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"], [data-testid="bookmark"], [data-testid="removeBookmark"], [data-testid="caret"], [data-testid="analyticsButton"], [data-testid="UserAvatar-Container-unknown"], [data-testid="Tweet-User-Avatar"]'
    );
    if (buttonLike && article.contains(buttonLike)) {
      // Exception: if it's a "Show more" (`显示更多`) link that points to `/status/<id>`, intercept it!
      if (
        buttonLike.getAttribute('data-testid') === 'tweet-text-show-more-link' &&
        buttonLike.tagName === 'A' &&
        buttonLike.href &&
        isPureStatusUrl(buttonLike.href)
      ) {
        return false;
      }
      return true;
    }

    // 2. Inline video/audio players, polls, and external link cards
    const mediaOrCard = target.closest(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], video, audio, [data-testid="card.wrapper"], [data-testid="poll"]'
    );
    if (mediaOrCard && article.contains(mediaOrCard)) {
      return true;
    }

    // 3. Anchor `<a>` links
    const anchor = target.closest('a[href]');
    if (anchor && article.contains(anchor)) {
      // Allow photo/video lightbox links (`/<user>/status/<id>/photo/1`) to open X's native media modal
      if (NON_DETAIL_STATUS_SUFFIX.test(anchor.getAttribute('href') || '')) {
        return true;
      }
      // If it's a pure `/status/<id>` link (e.g. timestamp or "显示更多"), intercept it to open in right panel!
      if (isPureStatusUrl(anchor.href)) {
        return false;
      }
      // Otherwise (user profile `/imwsl90`, `@mention`, `#hashtag`, `$cashtag`, external `t.co` link), allow native click
      return true;
    }

    return false;
  }

  /**
   * Resolve the target `/<user>/status/<id>` URL for a click inside `article[data-testid="tweet"]`
   */
  function resolveTweetStatusUrl(target, article) {
    // 1. Direct click on a `/status/<id>` link (such as timestamp or "显示更多")
    const clickedAnchor = target.closest('a[href]');
    if (
      clickedAnchor &&
      article.contains(clickedAnchor) &&
      isPureStatusUrl(clickedAnchor.href)
    ) {
      return clickedAnchor.href;
    }

    // 2. Click inside a Quoted Tweet card (`div[role="link"]` inside the article)
    const quoteCard = target.closest('div[role="link"]');
    if (quoteCard && article.contains(quoteCard)) {
      // Check if page-bridge extracted the quoted tweet URL from React Fiber
      const fiberQuoteUrl = quoteCard.getAttribute('data-superx-quote-url');
      if (fiberQuoteUrl && isPureStatusUrl(fiberQuoteUrl)) {
        return new URL(fiberQuoteUrl, window.location.origin).href;
      }
      // Or check if there is a status `<a>` link inside the quote card
      const quoteStatusLink = Array.from(
        quoteCard.querySelectorAll('a[href*="/status/"]')
      ).find((a) => isPureStatusUrl(a.href));
      if (quoteStatusLink) {
        return quoteStatusLink.href;
      }
      // If neither is on the DOM node yet, let `page-bridge.js` router guard catch X's internal push
      return null;
    }

    // 3. Standard click on the main tweet card body/text/header:
    // The first `[data-testid="User-Name"] a[href*="/status/"]` in `article` belongs to the main tweet
    const headerLinks = article.querySelectorAll(
      '[data-testid="User-Name"] a[href*="/status/"], a[href*="/status/"]'
    );
    for (let i = 0; i < headerLinks.length; i++) {
      const a = headerLinks[i];
      // Skip links that are inside a quoted tweet container
      const parentQuote = a.closest('div[role="link"]');
      if (parentQuote && article.contains(parentQuote)) continue;
      if (isPureStatusUrl(a.href)) {
        return a.href;
      }
    }

    return null;
  }

  // Capture-phase click listener on window (runs before X's React root listener)
  window.addEventListener(
    'click',
    (event) => {
      if (!settings.enabled) return;

      // Only intercept unmodified primary left clicks
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      // Do not intercept if the user just selected text
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) {
        return;
      }

      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      // Must be inside `[data-testid="primaryColumn"]`
      const primaryColumn = target.closest('[data-testid="primaryColumn"]');
      if (!primaryColumn) return;

      // Must be inside a tweet card `article[data-testid="tweet"]`
      const article = target.closest('article[data-testid="tweet"]');
      if (!article) return;

      // Check if clicking an action button, avatar, profile link, hashtag, photo, or video player
      if (shouldAllowNativeInteraction(target, article)) {
        return;
      }

      const statusUrl = resolveTweetStatusUrl(target, article);
      if (!statusUrl) {
        return;
      }

      // If user is already on this exact standalone status page in the main window, don't re-intercept
      const targetId = extractStatusId(statusUrl);
      const currentMainWindowId = extractStatusId(window.location.href);
      if (currentMainWindowId && currentMainWindowId === targetId) {
        return;
      }

      // Prevent X from navigating the main timeline page away!
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      openStatusInPanel(statusUrl, targetId);
    },
    true
  );

  // Close panel on Escape key in parent window
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPanelOpen) {
      const hasOpenModal =
        document.querySelector(
          '#layers [role="dialog"], #layers [data-testid="mask"], #layers [data-testid="swipe-to-dismiss"]'
        ) ||
        (panelEl && panelEl.classList.contains('superx-iframe-modal-open'));
      if (!hasOpenModal) {
        closePanel();
      }
    }
  });

  // Keep panel geometry and theme synchronized with X's layout
  window.addEventListener('resize', updatePanelGeometry, { passive: true });

  let observedPrimaryCol = null;
  const resizeObserver = new ResizeObserver(() => {
    updatePanelGeometry();
  });

  function syncParentModalState() {
    const hasParentModal = Boolean(
      document.querySelector(
        '#layers [role="dialog"], #layers [data-testid="swipe-to-dismiss"], #layers [aria-modal="true"]'
      ) || /\/status\/\d+\/(?:photo|video)\//.test(window.location.pathname)
    );
    document.documentElement.classList.toggle(
      'superx-parent-modal-open',
      hasParentModal
    );
  }

  function observeLayoutChanges() {
    const primaryCol = document.querySelector('[data-testid="primaryColumn"]');
    if (primaryCol && primaryCol !== observedPrimaryCol) {
      if (observedPrimaryCol) resizeObserver.unobserve(observedPrimaryCol);
      observedPrimaryCol = primaryCol;
      resizeObserver.observe(primaryCol);
      updatePanelGeometry();
      // Prewarm the detail iframe once primaryColumn is present on the page
      setTimeout(prewarmIframeIfNeeded, 800);
    }
    syncParentModalState();
    syncThemeFromPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      observeLayoutChanges();
      new MutationObserver(observeLayoutChanges).observe(document.body, {
        childList: true,
        subtree: true
      });
    });
  } else {
    observeLayoutChanges();
    new MutationObserver(observeLayoutChanges).observe(document.body, {
      childList: true,
      subtree: true
    });
  }
})();
