document.addEventListener('DOMContentLoaded', () => {
  const toggleEl = document.getElementById('toggle-enabled');
  const resetBtnEl = document.getElementById('btn-reset-width');

  chrome.storage.local.get(['superx_enabled'], (res) => {
    toggleEl.checked = res.superx_enabled !== false;
  });

  toggleEl.addEventListener('change', () => {
    chrome.storage.local.set({ superx_enabled: toggleEl.checked });
  });

  resetBtnEl.addEventListener('click', () => {
    chrome.storage.local.set({ superx_width: 0 }, () => {
      const origText = resetBtnEl.textContent;
      resetBtnEl.textContent = '已重置 ✓';
      setTimeout(() => {
        resetBtnEl.textContent = origText;
      }, 1200);
    });
  });
});
