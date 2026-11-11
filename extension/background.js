const RESUME_DELAY = 550;
const PAUSE_CHECK_DELAY = 180;
const initialState = Promise.all([
  chrome.storage.local.get({ enabled: true }),
  chrome.storage.session.get({ frames: {}, musicTabs: {} })
]).then(([preferences, session]) => ({ ...preferences, ...session, lastBlocked: 0, failedPauses: new Set() }));

let queue = Promise.resolve();
let resumeTimer;
let resumeAt = 0;

function enqueue(task) {
  const result = queue.then(async () => task(await initialState));
  queue = result.catch(error => console.error(error));
  return result;
}

function originOf(url) {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : '';
  } catch {
    return '';
  }
}

function isMusicSite(origin) {
  return origin === 'https://music.youtube.com';
}

function isMusicTab(state, tabId, origin) {
  return isMusicSite(origin) || Boolean(origin && state.musicTabs[tabId] === origin);
}

async function ask(frame, message) {
  const target = frame.documentId ? { documentId: frame.documentId } : { frameId: 0 };
  try {
    return await chrome.tabs.sendMessage(frame.tabId, message, target);
  } catch {
    return null;
  }
}

async function checkConnections(live, currentTab) {
  const connected = new Set(live.filter(frame => frame.media).map(frame => frame.tabId));
  const audible = await chrome.tabs.query({ audible: true, status: 'complete' });
  const playingTabs = audible.filter(tab => !tab.frozen && !tab.mutedInfo?.muted);
  const targets = new Set(playingTabs.map(tab => tab.id));
  if (currentTab?.status === 'complete' && originOf(currentTab.url)) targets.add(currentTab.id);

  const missing = new Set();
  await Promise.all([...targets].map(async tabId => {
    if (connected.has(tabId)) return;
    if (!await ask({ tabId }, { type: 'readMedia' })) missing.add(tabId);
  }));
  return {
    disconnected: playingTabs.filter(tab => missing.has(tab.id)).length,
    currentDisconnected: missing.has(currentTab?.id)
  };
}

async function reconcile(state, currentTab) {
  const live = await Promise.all(Object.values(state.frames).map(async frame => ({
    ...frame,
    musicTab: isMusicTab(state, frame.tabId, frame.origin),
    media: await ask(frame, { type: 'readMedia' })
  })));

  const videoTabs = new Set(live.filter(frame => frame.media?.video && !frame.musicTab)
    .map(frame => frame.tabId));
  const shouldPause = frame => state.enabled && videoTabs.size > Number(videoTabs.has(frame.tabId));
  const needsPause = frame => shouldPause(frame) &&
    (frame.media?.audio || (frame.media?.video && frame.musicTab));

  const toPause = live.filter(frame => needsPause(frame) && !state.failedPauses.has(frame.documentId));
  if (toPause.length) {
    await Promise.all(toPause.map(frame => ask(frame, { type: 'pauseMusic', musicTab: frame.musicTab })));
    // Let the site's pause handler run before checking whether playback stayed paused.
    await new Promise(resolve => setTimeout(resolve, PAUSE_CHECK_DELAY));
    await Promise.all(toPause.map(async frame => {
      frame.media = await ask(frame, { type: 'readMedia' });
    }));
  }
  const stillPlaying = live.filter(needsPause);
  state.failedPauses = new Set(stillPlaying.map(frame => frame.documentId));
  const pauseFailed = new Set(stillPlaying.map(frame => frame.tabId)).size;

  const ready = live.filter(frame => frame.media?.held && !shouldPause(frame));
  clearTimeout(resumeTimer);
  if (!ready.length) {
    resumeAt = 0;
  } else {
    resumeAt ||= Date.now() + RESUME_DELAY;
    const remaining = resumeAt - Date.now();
    if (!state.enabled || remaining <= 0) {
      await Promise.all(ready.map(async frame => {
        frame.media = await ask(frame, { type: 'resumeMusic' });
      }));
      resumeAt = 0;
    } else {
      resumeTimer = setTimeout(() => enqueue(reconcile), remaining);
    }
  }

  const heldTabs = new Set();
  for (const { documentId, media, tabId } of live) {
    if (media?.held) heldTabs.add(tabId);
    if (!media?.held && !media?.audio && !media?.video) delete state.frames[documentId];
  }

  await chrome.storage.session.set({ frames: state.frames });
  const health = state.enabled ? await checkConnections(live, currentTab) : {};
  const warning = pauseFailed || health.disconnected;
  const badge = !state.enabled ? 'OFF' : warning ? '!' : heldTabs.size ? String(heldTabs.size) : '';
  const color = !state.enabled ? '#5b6272' : warning ? '#ab421e' : '#18746d';
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text: badge });
  return { videos: videoTabs.size, held: heldTabs.size, pauseFailed, ...health };
}

async function popupState(state, message) {
  const tab = await chrome.tabs.get(message.tabId).catch(() => null);
  const origin = originOf(tab?.url);

  if (message.type === 'setEnabled') {
    state.enabled = message.enabled === true;
    await chrome.storage.local.set({ enabled: state.enabled });
  } else if (message.type === 'checkHealth') {
    state.failedPauses.clear();
  } else if (message.type === 'setMusicTab' && origin) {
    if (message.music === true) state.musicTabs[tab.id] = origin;
    else delete state.musicTabs[tab.id];
    await chrome.storage.session.set({ musicTabs: state.musicTabs });
  }

  return {
    ...await reconcile(state, tab),
    enabled: state.enabled,
    canMark: Boolean(origin),
    autoMusic: isMusicSite(origin),
    markedMusic: isMusicTab(state, tab?.id, origin),
    resumeBlocked: Date.now() - state.lastBlocked < 60_000
  };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'mediaChanged' && sender.tab && sender.documentId) {
    if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return;
    const { tab, documentId } = sender;
    const origin = originOf(tab.url) || originOf(sender.url);
    enqueue(async state => {
      state.frames[documentId] = { tabId: tab.id, documentId, origin };
      await reconcile(state);
    });
  } else if (message.type === 'resumeBlocked' && sender.tab && sender.documentId) {
    enqueue(state => { state.lastBlocked = Date.now(); });
  } else if (sender.url === chrome.runtime.getURL('popup.html') &&
      ['getPopup', 'checkHealth', 'setEnabled', 'setMusicTab'].includes(message.type)) {
    enqueue(state => popupState(state, message)).then(reply, () => reply(null));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => enqueue(async state => {
  const removed = Object.values(state.frames).filter(frame => frame.tabId === tabId);
  for (const frame of removed) delete state.frames[frame.documentId];
  if (state.musicTabs[tabId]) {
    delete state.musicTabs[tabId];
    await chrome.storage.session.set({ musicTabs: state.musicTabs });
  }
  await reconcile(state);
}));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const audioChanged = change.audible !== undefined;
  if (!audioChanged && !change.url && !change.discarded && change.status !== 'complete') return;
  enqueue(async state => {
    if (change.url && state.musicTabs[tabId] && state.musicTabs[tabId] !== originOf(change.url)) {
      delete state.musicTabs[tabId];
      await chrome.storage.session.set({ musicTabs: state.musicTabs });
    }
    if (audioChanged || (change.status === 'complete' && tab.audible) ||
        Object.values(state.frames).some(frame => frame.tabId === tabId)) await reconcile(state);
  });
});

chrome.runtime.onInstalled.addListener(() => enqueue(reconcile));
chrome.runtime.onStartup.addListener(() => enqueue(reconcile));
