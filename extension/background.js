const RESUME_DELAY = 550;
const initialState = Promise.all([
  chrome.storage.local.get({ enabled: true }),
  chrome.storage.session.get({ frames: {}, musicTabs: {} })
]).then(([preferences, session]) => ({ ...preferences, ...session, lastBlocked: 0 }));

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
  try {
    return await chrome.tabs.sendMessage(frame.tabId, message, { documentId: frame.documentId });
  } catch {
    return null;
  }
}

async function reconcile(state) {
  const live = await Promise.all(Object.values(state.frames).map(async frame => ({
    ...frame,
    musicTab: isMusicTab(state, frame.tabId, frame.origin),
    media: await ask(frame, { type: 'readMedia' })
  })));

  const videoTabs = new Set(live.filter(frame => frame.media?.video && !frame.musicTab)
    .map(frame => frame.tabId));
  const shouldPause = frame => state.enabled && videoTabs.size > Number(videoTabs.has(frame.tabId));

  await Promise.all(live.map(async frame => {
    const { media, musicTab } = frame;
    if (shouldPause(frame) && (media?.audio || (media?.video && musicTab))) {
      frame.media = await ask(frame, { type: 'pauseMusic', musicTab });
    }
  }));

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
  const badge = !state.enabled ? 'OFF' : heldTabs.size ? String(heldTabs.size) : '';
  await chrome.action.setBadgeBackgroundColor({ color: state.enabled ? '#18746d' : '#5b6272' });
  await chrome.action.setBadgeText({ text: badge });
  return { videos: videoTabs.size, held: heldTabs.size };
}

async function popupState(state, message) {
  const tab = await chrome.tabs.get(message.tabId).catch(() => null);
  const origin = originOf(tab?.url);

  if (message.type === 'setEnabled') {
    state.enabled = message.enabled === true;
    await chrome.storage.local.set({ enabled: state.enabled });
  } else if (message.type === 'setMusicTab' && origin) {
    if (message.music === true) state.musicTabs[tab.id] = origin;
    else delete state.musicTabs[tab.id];
    await chrome.storage.session.set({ musicTabs: state.musicTabs });
  }

  return {
    ...await reconcile(state),
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
      ['getPopup', 'setEnabled', 'setMusicTab'].includes(message.type)) {
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
  if (removed.length) await reconcile(state);
}));

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && !change.discarded && change.status !== 'complete') return;
  enqueue(async state => {
    if (change.url && state.musicTabs[tabId] && state.musicTabs[tabId] !== originOf(change.url)) {
      delete state.musicTabs[tabId];
      await chrome.storage.session.set({ musicTabs: state.musicTabs });
    }
    if (Object.values(state.frames).some(frame => frame.tabId === tabId)) await reconcile(state);
  });
});
