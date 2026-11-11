const enabled = document.getElementById('enabled');
const music = document.getElementById('music');
const musicHint = document.getElementById('musicHint');
const status = document.getElementById('status');
const check = document.getElementById('check');
let updating = false;

async function update(message = { type: 'getPopup' }) {
  if (updating) return;
  updating = true;
  enabled.disabled = true;
  music.disabled = true;
  check.disabled = true;
  let responseTimer;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const timeout = new Promise((_, reject) => {
      responseTimer = setTimeout(() => reject(new Error('Background response timed out')), 4000);
    });
    const state = await Promise.race([chrome.runtime.sendMessage({ ...message, tabId: tab?.id }), timeout]);
    enabled.checked = state.enabled;
    enabled.disabled = false;
    music.checked = state.markedMusic;
    music.disabled = !state.canMark || state.autoMusic;
    musicHint.textContent = state.autoMusic ? '已自動辨識為 YouTube Music。' :
      state.canMark ? 'YouTube 歌單可在這裡指定。' : '請在要指定的網頁分頁開啟。';

    status.classList.toggle('warning', state.enabled && Boolean(state.pauseFailed || state.disconnected ||
      state.currentDisconnected || state.resumeBlocked));
    if (!state.enabled) status.textContent = '自動接播已關閉';
    else if (state.pauseFailed) status.textContent = '已偵測到影片，但音樂仍在播放。可重新檢查，或先手動暫停音樂。';
    else if (state.currentDisconnected) status.textContent = '這個分頁未連線，請重新整理網頁並確認擴充功能的網站存取權。';
    else if (state.disconnected) status.textContent = `有 ${state.disconnected} 個播放聲音的分頁未連線，請重新整理該分頁。`;
    else if (state.held) status.textContent = `已暫停 ${state.held} 個音樂分頁`;
    else if (state.resumeBlocked) status.textContent = '瀏覽器阻止自動接播，請手動播放音樂。';
    else if (state.videos) status.textContent = `偵測到 ${state.videos} 個影片分頁`;
    else status.textContent = '等待影片播放';
  } catch {
    status.classList.add('warning');
    status.textContent = '擴充功能的背景程式未回應。請到擴充功能管理頁重新載入。';
  } finally {
    clearTimeout(responseTimer);
    updating = false;
    check.disabled = false;
  }
}

enabled.addEventListener('change', () => update({ type: 'setEnabled', enabled: enabled.checked }));
music.addEventListener('change', () => update({ type: 'setMusicTab', music: music.checked }));
check.addEventListener('click', () => update({ type: 'checkHealth' }));
update();
