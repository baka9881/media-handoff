const enabled = document.getElementById('enabled');
const music = document.getElementById('music');
const musicHint = document.getElementById('musicHint');
const status = document.getElementById('status');
let updating = false;

async function update(message = { type: 'getPopup' }) {
  if (updating) return;
  updating = true;
  enabled.disabled = true;
  music.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const state = await chrome.runtime.sendMessage({ ...message, tabId: tab?.id });
    enabled.checked = state.enabled;
    enabled.disabled = false;
    music.checked = state.markedMusic;
    music.disabled = !state.canMark || state.autoMusic;
    musicHint.textContent = state.autoMusic ? '已自動辨識為 YouTube Music。' :
      state.canMark ? 'YouTube 歌單可在這裡指定。' : '請在要指定的網頁分頁開啟。';

    if (!state.enabled) status.textContent = '自動接播已關閉';
    else if (state.held) status.textContent = `已暫停 ${state.held} 個音樂分頁`;
    else if (state.resumeBlocked) status.textContent = '瀏覽器阻止自動接播，請手動播放音樂。';
    else if (state.videos) status.textContent = `偵測到 ${state.videos} 個影片分頁`;
    else status.textContent = '等待影片播放';
  } catch {
    status.textContent = '讀取失敗，請重新開啟這個面板。';
  } finally {
    updating = false;
  }
}

enabled.addEventListener('change', () => update({ type: 'setEnabled', enabled: enabled.checked }));
music.addEventListener('change', () => update({ type: 'setMusicTab', music: music.checked }));
update();
