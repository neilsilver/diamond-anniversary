(() => {
  'use strict';

  const SLIDE_SECONDS = 5;       // default; override per photo with "duration" in photos.json
  const CLOSING_SECONDS = 10;
  const FADE_MS = 1500;          // keep in step with --fade in style.css
  const IDLE_MS = 3000;
  const MUSIC_FADE_MS = 4000;
  const COVER_MAX_CROP = 0.12;   // fill the frame if that crops no more than this fraction
  const SWIPE_PX = 40;

  const $ = (sel) => document.querySelector(sel);
  const stage = $('#stage');
  const layers = [...stage.querySelectorAll('.layer')].map((el) => ({
    el,
    bg: el.querySelector('.bg'),
    fg: el.querySelector('.fg'),
    motion: null,
  }));
  const titleCard = $('#title');
  const closingCard = $('#closing');
  const beginButton = $('#begin');
  const toggleButton = $('#toggle');
  const fullscreenButton = $('#fullscreen');
  const progressBar = $('#progress-bar');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let photos = [];
  let index = 0;            // photos.length means the closing card
  let active = 0;           // which layer is on top
  let started = false;
  let playing = false;
  let showToken = 0;
  let timer = null;
  let slideMs = 0;
  let elapsed = 0;          // ms of the current slide already shown before the last pause
  let resumedAt = 0;
  let idleTimer = null;
  let wakeLock = null;
  let resumeWhenVisible = false;
  let music = null;
  let audioCtx = null;
  let gain = null;

  // ---------- Loading ----------

  const preloaded = new Map();

  // decode() can stall while the tab is in the background, so never wait on it forever.
  const DECODE_TIMEOUT_MS = 4000;
  const decoded = (img) => Promise.race([
    img.decode().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, DECODE_TIMEOUT_MS)),
  ]);

  function preload(i) {
    const file = photos[i].file;
    if (!preloaded.has(file)) {
      const img = new Image();
      img.src = file;
      preloaded.set(file, decoded(img));
    }
    return preloaded.get(file);
  }

  function prunePreloaded() {
    const keep = new Set([0, 1, 2].map((n) => photos[(index + n) % photos.length].file));
    for (const file of preloaded.keys()) {
      if (!keep.has(file)) preloaded.delete(file);
    }
  }

  // ---------- Slides ----------

  function applyFit(layer) {
    const { naturalWidth: w, naturalHeight: h } = layer.fg;
    if (!w || !h) return;
    const photo = w / h;
    const frame = stage.clientWidth / stage.clientHeight;
    const crop = 1 - Math.min(photo, frame) / Math.max(photo, frame);
    layer.el.classList.toggle('cover', crop <= COVER_MAX_CROP);
  }

  function startMotion(layer, ms) {
    if (layer.motion) layer.motion.cancel();
    layer.motion = null;
    if (reducedMotion || !layer.fg.animate) return;
    // Pan along a random direction while zooming; the offset at each end is the
    // most that scale allows without pulling an edge into view.
    const angle = Math.random() * 2 * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const frame = (scale, sign) => {
      const max = ((scale - 1) / (2 * scale)) * 100;
      return { transform: `scale(${scale}) translate(${sign * dx * max}%, ${sign * dy * max}%)` };
    };
    const frames = [frame(1.02, -1), frame(1.08 + Math.random() * 0.07, 1)];
    if (Math.random() < 0.5) frames.reverse();
    layer.motion = layer.fg.animate(frames, { duration: ms + FADE_MS, easing: 'linear', fill: 'both' });
    if (!playing) layer.motion.pause();
  }

  async function show(i) {
    const token = ++showToken;
    clearTimeout(timer);
    const total = photos.length + 1;
    i = ((i % total) + total) % total;

    if (i === photos.length) {
      index = i;
      closingCard.classList.add('visible');
      fadeMusic(0);
      begin(CLOSING_SECONDS * 1000);
      return;
    }

    await preload(i);
    if (token !== showToken) return;

    const incoming = layers[1 - active];
    const outgoing = layers[active];
    const file = photos[i].file;
    incoming.fg.src = file;
    incoming.bg.src = file;
    await Promise.all([decoded(incoming.fg), decoded(incoming.bg)]);
    if (token !== showToken) return;

    index = i;
    active = 1 - active;
    closingCard.classList.remove('visible');
    fadeMusic(1);
    applyFit(incoming);

    // The new photo fades in on top; the old one stays opaque underneath so the
    // crossfade never dips to black, and is hidden once it is fully covered.
    incoming.el.style.zIndex = 2;
    outgoing.el.style.zIndex = 1;
    incoming.el.classList.add('active');
    setTimeout(() => {
      if (token === showToken) outgoing.el.classList.remove('active');
    }, FADE_MS);

    const ms = (photos[i].duration || SLIDE_SECONDS) * 1000;
    startMotion(incoming, ms);
    begin(ms);

    preload((i + 1) % photos.length);
    preload((i + 2) % photos.length);
    prunePreloaded();
  }

  function begin(ms) {
    slideMs = ms;
    elapsed = 0;
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    resumedAt = performance.now();
    timer = setTimeout(() => show(index + 1), slideMs - elapsed);
  }

  function play() {
    if (playing) return;
    playing = true;
    document.body.classList.remove('paused');
    toggleButton.setAttribute('aria-label', 'Pause');
    layers.forEach((l) => l.motion && l.motion.playState === 'paused' && l.motion.play());
    if (music) music.play().catch(() => {});
    schedule();
  }

  function pause() {
    if (!playing) return;
    playing = false;
    elapsed += performance.now() - resumedAt;
    clearTimeout(timer);
    document.body.classList.add('paused');
    toggleButton.setAttribute('aria-label', 'Play');
    layers.forEach((l) => l.motion && l.motion.playState === 'running' && l.motion.pause());
    if (music) music.pause();
  }

  const toggle = () => (playing ? pause() : play());
  const next = () => show(index + 1);
  const prev = () => show(index - 1);

  function drawProgress() {
    const shown = Math.min(elapsed + (playing ? performance.now() - resumedAt : 0), slideMs);
    const fraction = slideMs ? shown / slideMs : 0;
    progressBar.style.transform = `scaleX(${(index + fraction) / (photos.length + 1)})`;
    requestAnimationFrame(drawProgress);
  }

  // ---------- Music, wake lock, fullscreen ----------

  function startMusic() {
    const src = document.body.dataset.music;
    if (!src) return;
    music = new Audio(src);
    music.loop = true;
    // Volume goes through a gain node because iOS ignores audio.volume.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      gain = audioCtx.createGain();
      audioCtx.createMediaElementSource(music).connect(gain).connect(audioCtx.destination);
    } catch (err) {
      gain = null;
    }
    music.play().catch(() => {});
  }

  function fadeMusic(to) {
    if (!gain || gain.gain.value === to) return;
    const now = audioCtx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(to, now + MUSIC_FADE_MS / 1000);
  }

  async function keepAwake() {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      wakeLock = null;
    }
  }

  function toggleFullscreen() {
    const request = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    request.catch(() => {});
  }

  // ---------- Input ----------

  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    if (started) idleTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
  }

  function start() {
    if (started || beginButton.disabled) return;
    started = true;
    document.body.classList.add('started');
    titleCard.classList.remove('visible');
    if (document.fullscreenEnabled) toggleFullscreen();
    keepAwake();
    startMusic();
    play();
    requestAnimationFrame(drawProgress);
    wake();
  }

  let pointerStart = null;

  stage.addEventListener('pointerdown', (e) => {
    pointerStart = { x: e.clientX, y: e.clientY };
  });

  stage.addEventListener('pointerup', (e) => {
    if (!pointerStart || !started) return;
    const dx = e.clientX - pointerStart.x;
    const dy = e.clientY - pointerStart.y;
    pointerStart = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      return dx < 0 ? next() : prev();
    }
    if (Math.abs(dx) > SWIPE_PX || Math.abs(dy) > SWIPE_PX) return;
    // Taps: left third goes back, right third goes forward, middle pauses.
    const third = e.clientX / stage.clientWidth;
    if (third < 1 / 3) prev();
    else if (third > 2 / 3) next();
    else toggle();
  });

  // The closing card sits above the stage; a tap there moves on.
  closingCard.addEventListener('click', next);

  document.addEventListener('keydown', (e) => {
    wake();
    if (!started) {
      if (e.key === 'Enter' || e.key === ' ') start();
      return;
    }
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'f' && document.fullscreenEnabled) toggleFullscreen();
  });

  ['pointermove', 'pointerdown'].forEach((type) => document.addEventListener(type, wake));

  beginButton.addEventListener('click', start);
  toggleButton.addEventListener('click', toggle);
  $('#next').addEventListener('click', next);
  $('#prev').addEventListener('click', prev);
  fullscreenButton.addEventListener('click', toggleFullscreen);
  if (!document.fullscreenEnabled) fullscreenButton.hidden = true;

  window.addEventListener('resize', () => applyFit(layers[active]));

  document.addEventListener('visibilitychange', () => {
    if (!started) return;
    if (document.hidden) {
      resumeWhenVisible = playing;
      pause();
    } else {
      keepAwake();
      if (resumeWhenVisible) play();
    }
  });

  // ---------- Boot ----------

  fetch('photos.json')
    .then((res) => res.json())
    .then((list) => {
      photos = list;
      if (!photos.length) throw new Error('photos.json is empty');
      // The first photo waits, paused, under the title card.
      return show(0);
    })
    .then(() => {
      beginButton.disabled = false;
      beginButton.textContent = 'Tap to begin';
    })
    .catch(() => {
      beginButton.textContent = 'Photos could not be loaded';
    });
})();
