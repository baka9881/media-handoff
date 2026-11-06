(() => {
  const selector = 'audio, video';
  const mediaElements = new Set();
  const held = new Map();
  let available = true;
  let lastReport = '';
  let heartbeat;
  let pending = false;

  function kind(media) {
    if (!media.isConnected || media.paused || media.ended || media.error ||
        media.muted || media.volume === 0 || media.readyState < HTMLMediaElement.HAVE_METADATA) {
      return null;
    }
    return media instanceof HTMLVideoElement && media.videoWidth > 0 ? 'video' : 'audio';
  }

  function currentHold(media, saved) {
    return media.isConnected && media.paused && !media.ended && !media.error &&
      media.currentSrc === saved.source && media.srcObject === saved.stream &&
      location.href === saved.page;
  }

  function snapshot() {
    if (!available) return null;

    for (const [media, saved] of held) {
      if (!currentHold(media, saved)) held.delete(media);
    }
    const state = { audio: false, video: false, held: held.size > 0 };
    for (const media of mediaElements) {
      const type = kind(media);
      if (type) state[type] = true;
    }
    return state;
  }

  function send(type) {
    try {
      chrome.runtime.sendMessage({ type }).catch(() => {});
    } catch {
      // The extension can be reloaded while this page is still open.
    }
  }

  function report() {
    const state = snapshot();
    const next = state && (state.audio || state.video || state.held) ? JSON.stringify(state) : '';
    if (next !== lastReport) {
      lastReport = next;
      send('mediaChanged');
    }
    if (state?.held && heartbeat === undefined) {
      // Recheck after an embedded player disappears without a final media event.
      heartbeat = setInterval(() => send('mediaChanged'), 2500);
    } else if (!state?.held && heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  function scheduleReport() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      report();
    });
  }

  function discover(node) {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLMediaElement) mediaElements.add(node);
    for (const media of node.querySelectorAll(selector)) mediaElements.add(media);
  }

  const events = ['play', 'playing', 'pause', 'ended', 'error', 'emptied',
    'loadedmetadata', 'resize', 'volumechange'];
  for (const name of events) {
    document.addEventListener(name, event => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;
      mediaElements.add(media);
      if (name === 'emptied' || name === 'ended' || name === 'error') held.delete(media);
      scheduleReport();
    }, true);
  }

  new MutationObserver(changes => {
    const previous = mediaElements.size;
    for (const change of changes) {
      for (const node of change.addedNodes) discover(node);
    }
    let removed = false;
    for (const media of mediaElements) {
      if (media.isConnected) continue;
      mediaElements.delete(media);
      held.delete(media);
      removed = true;
    }
    if (removed || previous !== mediaElements.size) scheduleReport();
  }).observe(document, { childList: true, subtree: true });

  addEventListener('pagehide', () => {
    available = false;
    held.clear();
    report();
  });
  addEventListener('pageshow', () => {
    available = true;
    report();
  });

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !available) return;

    if (message.type === 'pauseMusic') {
      for (const media of mediaElements) {
        const type = kind(media);
        if (!type || (type === 'video' && !message.musicTab)) continue;
        const saved = { source: media.currentSrc, stream: media.srcObject, page: location.href };
        media.pause();
        if (media.paused) held.set(media, saved);
      }
    } else if (message.type === 'resumeMusic') {
      for (const [media, saved] of held) {
        if (currentHold(media, saved)) {
          media.play().catch(error => {
            if (error.name === 'NotAllowedError') send('resumeBlocked');
          });
        }
      }
      held.clear();
    } else if (message.type !== 'readMedia') {
      return;
    }

    reply(snapshot());
    scheduleReport();
  });

  discover(document.documentElement);
  report();
})();
