// こども向けの おもちゃ 共通キット (音の合成・読み上げ・タップでスタート)
// <script src="common/kit.js"></script> で読み込み、window.Kit を使う。

(() => {
  // ---- 誤操作・ブラウザ挙動の抑止 ----
  const prevent = (e) => e.preventDefault();
  document.addEventListener("gesturestart", prevent, { passive: false }); // iOS ピンチ
  document.addEventListener("contextmenu", prevent); // 長押しメニュー
  document.addEventListener("dblclick", prevent, { passive: false }); // ダブルタップズーム
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );

  // ---- 音 (WebAudio で合成。音源ファイル不要) ----
  // iPadOS/iOS: 消音モード中でも WebAudio を鳴らす (Safari 16.4+。未対応ブラウザでは何もしない)
  // 読み上げと BGM の混ざり方は type で変わる (iPad で切り分け中)。おとのテストで端末ごとに変えられる (localStorage)
  const SESSION_KEY = "piano-audiosession";
  // 既定は "auto"。"playback" (消音モードでも鳴る) だと、iPad は読み上げのあいだ BGM を止めたり 小さくしたりした。
  // auto / ambient では読み上げと BGM が混ざって鳴ることを iPad で確認 (2026-10-23)。代わりに消音モードでは鳴らないことがある
  let sessionType = "auto";
  try { sessionType = localStorage.getItem(SESSION_KEY) || "auto"; } catch (e) {}
  try { if (navigator.audioSession) navigator.audioSession.type = sessionType; } catch (e) {}
  let ctx = null;
  let master = null;
  // iOS は 読み上げ中など AudioContext を "interrupted" にする。効果音のたびに resume() を呼ぶと
  // そのたびに音の経路を組み直して 画面が止まることがあるので、操作の外では 1 秒に 1 回までにする
  let lastResume = 0;
  const audio = (force = false) => {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    }
    if (ctx.state !== "running") {
      const now = performance.now();
      if (force || now - lastResume > 1000) {
        lastResume = now;
        ctx.resume()?.catch?.(() => {});
      }
    }
    return ctx;
  };

  // ---- 音と読み上げの解錠 ----
  // iOS Safari は「ユーザー操作の中」で AudioContext を動かし・最初の読み上げをしないと、ずっと無音のまま。
  // しかも pointerdown はユーザー操作と認められない (iPad で確認: pointerdown 内の speak() は黙って捨てられる)。
  // そこで touchend / click / keydown を capture で拾い (ゲーム側の stopPropagation に負けない)、
  // 実際に読み上げが始まった (start/end イベントが来た) と確認できるまで毎回試す。
  let speechUnlocked = false;
  let pendingUtter = null; // 解錠前に頼まれた読み上げ。次のユーザー操作で読む
  const hasSpeech = "speechSynthesis" in window;
  const watchSpeech = (u) => {
    const ok = () => {
      speechUnlocked = true;
      if (pendingUtter === u) pendingUtter = null;
    };
    u.addEventListener("start", ok);
    u.addEventListener("end", ok);
  };
  const unlockSpeech = () => {
    if (speechUnlocked || !hasSpeech) return;
    let u = pendingUtter;
    pendingUtter = null;
    if (!u) {
      u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      watchSpeech(u);
    }
    if (FIX) resumeIfPaused(u);
    if (u.__kitRec) slog(u, "unlock-speak");
    speechSynthesis.speak(u);
  };
  const unlockAudio = (force = false) => {
    try {
      const c = audio(force);
      // 無音を 1 サンプル鳴らすと、古い iOS でも確実に解錠される
      const s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, 22050);
      s.connect(c.destination);
      s.start(0);
    } catch (e) {}
  };
  // pointerdown でも AudioContext は試す (効く端末では最初の一音が早くなる)。読み上げは本物のユーザー操作でだけ
  // iPad で pointerup がユーザー操作として通ることを確認済み (2026-10-05, iPadOS 18.7 ホーム画面アプリ)
  const ACTIVATION_EVENTS = ["pointerup", "touchend", "click", "keydown", "mouseup"];
  const onActivation = () => {
    unlockAudio(true);
    unlockSpeech();
    if (ctx && ctx.state === "running" && (speechUnlocked || !hasSpeech)) {
      ACTIVATION_EVENTS.forEach((ev) => document.removeEventListener(ev, onActivation, true));
    }
  };
  ACTIVATION_EVENTS.forEach((ev) => document.addEventListener(ev, onActivation, { capture: true, passive: true }));
  // 解錠のあとも、読み上げなどで iOS が AudioContext を止めることがある ("interrupted")。
  // その再開もユーザー操作の中でしか通らないので、指をはなすたびに 止まっていれば動かし直す (pointerdown では通らない)
  ["pointerup", "touchend", "click"].forEach((ev) => document.addEventListener(ev, () => {
    if (ctx && ctx.state !== "running") audio(true);
  }, { capture: true, passive: true }));
  // (解錠後も 読み上げ中は "interrupted" になるので、ここは間引いた resume だけ)
  document.addEventListener("pointerdown", () => { if (!ctx || ctx.state !== "running") unlockAudio(); }, { capture: true, passive: true });

  // ペンタトニック（どの音を組み合わせても濁らない）
  const PENTA = [0, 2, 4, 7, 9];
  const noteFreq = (i, base = 60) => {
    const oct = Math.floor(i / PENTA.length);
    const deg = ((i % PENTA.length) + PENTA.length) % PENTA.length;
    const midi = base + oct * 12 + PENTA[deg];
    return 440 * Math.pow(2, (midi - 69) / 12);
  };

  // 同時に鳴っている tone の上限。連打で数百の音が重なると 音が割れて重くなる
  // (Linux の headless WebKit はこれで落ちていた)。超えた分は鳴らさない
  const MAX_VOICES = 32;
  let voiceEnds = [];
  const tone = (freq, { dur = 0.3, type = "sine", vol = 0.6, slide = 0, delay = 0 } = {}) => {
    if (!isFinite(freq) || freq <= 0 || !isFinite(dur) || dur <= 0) return;
    const c = audio();
    const t = c.currentTime + delay;
    voiceEnds = voiceEnds.filter((e) => e > c.currentTime);
    if (voiceEnds.length >= MAX_VOICES) return;
    voiceEnds.push(t + dur + 0.05);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  };

  const sfx = {
    pop: () => {
      tone(500 + Math.random() * 400, { dur: 0.12, type: "sine", slide: 2.5 });
    },
    boing: () => tone(180, { dur: 0.35, type: "triangle", slide: 2.2 }),
    chime: (i = Math.floor(Math.random() * 10)) => {
      tone(noteFreq(i, 72), { dur: 0.6, type: "sine", vol: 0.4 });
      tone(noteFreq(i, 84), { dur: 0.4, type: "sine", vol: 0.15 });
    },
    note: (i, opts) => tone(noteFreq(i), { dur: 0.5, type: "triangle", ...opts }),
    fanfare: () => [0, 2, 4, 7].forEach((n, k) => sfx.note(n + 5, { delay: k * 0.1, dur: 0.4 })),
  };

  // ---- 読み上げ (動物の鳴き声など) ----
  // 日本語の声を明示的に選ぶ (lang 指定だけだと端末によって英語の声で読むことがある)
  let jaVoice = null;
  const pickVoice = () => {
    const vs = speechSynthesis.getVoices();
    jaVoice = vs.find((v) => v.lang === "ja-JP" && v.localService) || vs.find((v) => /^ja/i.test(v.lang)) || null;
  };
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
  }
  // 作った SpeechSynthesisUtterance を返す (読み終わりを知りたいときに end を拾える)
  // iOS は 読み上げのあいだ AudioContext を止める ("interrupted") ことがある。読み終わったら すぐ動かし直す
  const resumeAfterSpeech = () => setTimeout(() => { if (ctx && ctx.state !== "running") audio(true); }, 30);
  // いま Kit.say の読み上げ中か (BGM を下げる判定用)。speechSynthesis.speaking は iOS で当てにならない
  // (解錠用の無音の発話や cancel のあとも true のまま残ることがある) ので、自分で数える。
  // 終わり (end/error) か、文の長さから見積もった時間を過ぎたら 必ず外す
  let speakingUntil = 0, speakingU = null;
  const speaking = () => speakingU !== null && performance.now() < speakingUntil;
  const say = (text, { rate = 1, pitch = 1.4 } = {}) => {
    if (!("speechSynthesis" in window)) return null;
    const u = new SpeechSynthesisUtterance(text);
    speakingU = u;
    speakingUntil = performance.now() + 1500 + (String(text).length * 260) / (rate || 1);
    const done = () => { if (speakingU === u) speakingU = null; resumeAfterSpeech(); };
    u.lang = "ja-JP";
    if (jaVoice && !noVoice) u.voice = jaVoice;
    u.rate = rate;
    u.pitch = pitch;
    track(u, text); // 記録と Android 向けの手当て。error の手当て (読み直し) は done より先に聞く
    u.addEventListener("end", done);
    u.addEventListener("error", done);
    if (!speechUnlocked) {
      // まだ解錠されていない: いま読めればそれでよし、捨てられても次のユーザー操作 (指をはなす等) で読む
      slog(u, "未解錠");
      watchSpeech(u);
      pendingUtter = u;
      speakNow(u);
      return u;
    }
    // Safari は cancel() の直後に speak() すると無視することがあるので、読み上げ中のときだけ止めて少し待つ
    // 待っている予約は最新の 1 つだけ (60ms の間に次が来たら古い方は捨てる。連打で順番がずれる/二重に読むのを防ぐ)
    // Android の Chrome は 60ms だと cancel の後片付けが終わらず 捨てられることがあるので 250ms
    clearTimeout(sayTimer);
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      if (IS_ANDROID) slog(u, "wait250");
      sayTimer = setTimeout(() => speakNow(u), IS_ANDROID ? 250 : 60);
    } else {
      speakNow(u);
    }
    return u;
  };
  let sayTimer = null;

  // ---- 読み上げの記録 (おとのテストの「こえの きろく」で見る) と Android 向けの手当て ----
  // 1 回の say を 1 行にまとめ、localStorage に最新 50 行だけ残す (ページをまたいで残る)。
  // 手当て (FIX) は iOS 以外だけ: iPad は今の挙動 (解錠前の say を次の pointerup で読む 等) のまま
  const UA = navigator.userAgent || "";
  const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(UA);
  const FIX = !IS_IOS;
  const uaSummary = () => {
    const os = IS_ANDROID ? `Android ${(UA.match(/Android ([\d.]+)/) || [])[1] || ""}`
      : IS_IOS ? `iOS ${((UA.match(/OS (\d+[_\d]*) like/) || [])[1] || "").replace(/_/g, ".")}` : "その他";
    const br = (UA.match(/(EdgA?|SamsungBrowser|CriOS|FxiOS|Firefox|Chrome)\/(\d+)/) || [])
      .slice(1, 3).join(" ") || (/Safari/.test(UA) ? `Safari ${(UA.match(/Version\/([\d.]+)/) || [])[1] || ""}` : "?");
    return `${os.trim()} / ${br.trim()}${matchMedia?.("(display-mode: standalone)").matches || navigator.standalone ? " / ホーム画面" : ""}`;
  };
  const SPEECH_LOG_KEY = "piano-speech-log";
  const LOG_MAX = 50;
  let speechLog = null, saveTimer = null;
  const loadLog = () => {
    if (speechLog) return speechLog;
    try { speechLog = JSON.parse(localStorage.getItem(SPEECH_LOG_KEY) || "null"); } catch (e) {}
    if (!speechLog || !Array.isArray(speechLog.items)) speechLog = { items: [] };
    return speechLog;
  };
  const saveLog = () => {
    clearTimeout(saveTimer); saveTimer = null;
    if (!speechLog) return;
    try { localStorage.setItem(SPEECH_LOG_KEY, JSON.stringify(speechLog)); } catch (e) {}
  };
  const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(saveLog, 300); };
  addEventListener("pagehide", saveLog);
  const synthState = () => {
    try {
      const s = speechSynthesis;
      return `s${+s.speaking}p${+s.pending}P${+s.paused}h${+document.hidden}`;
    } catch (e) { return "?"; }
  };
  // u の行に出来事を 1 つ足す (say してからの ms つき)
  const slog = (u, what) => {
    const r = u && u.__kitRec;
    if (!r) return;
    r.ev.push(`${what}@${Math.round(performance.now() - u.__kitT0)}`);
    if (r.ev.length > 12) r.ev.splice(1, 1);
    saveSoon();
  };
  const resumeIfPaused = (u) => {
    try {
      if (speechSynthesis.paused) { speechSynthesis.resume(); slog(u, "resume"); }
    } catch (e) {}
  };
  let noVoice = false; // voice を付けない方が読めた端末 (セッション内)
  const START_TIMEOUT = 1500;
  let watchU = null, watchTimer = null; // start を待っている発話 (最新の 1 つだけ)
  // ほんとうに speak() する。start が 1.5 秒来なければ 1 回だけ 止めて読み直す
  const speakNow = (u) => {
    if (FIX) resumeIfPaused(u);
    clearTimeout(watchTimer);
    watchU = u;
    watchTimer = setTimeout(() => onNoStart(u), START_TIMEOUT);
    speechSynthesis.speak(u);
  };
  const onNoStart = (u) => {
    if (watchU !== u || u.__kitStarted || u.__kitEnded) return;
    slog(u, `timeout(${synthState()})`);
    // 解錠前 (次のユーザー操作で読む) と 画面が隠れているとき は待つだけ。iOS は記録だけ
    if (!FIX || !speechUnlocked || pendingUtter === u || document.hidden || u.__kitRetryT) return;
    u.__kitRetryT = true;
    slog(u, "retry-timeout");
    u.__kitSelfCancel = true; // この cancel で来る interrupted/canceled は 呼び出し側に見せない
    try { speechSynthesis.cancel(); speechSynthesis.resume(); } catch (e) {}
    setTimeout(() => {
      if (speakingU !== u) return; // そのあいだに 次の say が来た
      speakingUntil = Math.max(speakingUntil, performance.now() + 1500 + String(u.text).length * 260);
      speakNow(u);
    }, IS_ANDROID ? 250 : 60);
  };
  const SKIP_RETRY = ["interrupted", "canceled", "not-allowed"];
  const track = (u, text) => {
    const log = loadLog();
    const v = u.voice;
    u.__kitT0 = performance.now();
    u.__kitRec = { t: Date.now(), x: String(text).slice(0, 10), v: v ? v.name : "(なし)", vl: v ? v.lang : u.lang, vs: v ? (v.localService ? "local" : "net") : "-", st: synthState(), ev: [] };
    log.ua = uaSummary();
    log.items.push(u.__kitRec);
    if (log.items.length > LOG_MAX) log.items.splice(0, log.items.length - LOG_MAX);
    saveSoon();
    u.addEventListener("start", () => {
      u.__kitStarted = true;
      u.__kitSelfCancel = false;
      slog(u, "start");
      if (u.__kitNoVoiceTry && !noVoice) { noVoice = true; slog(u, "以後voiceなし"); }
    });
    u.addEventListener("end", () => { u.__kitEnded = true; slog(u, "end"); });
    u.addEventListener("error", (e) => {
      const err = e.error || "?";
      if (u.__kitSelfCancel && speakingU === u && (err === "interrupted" || err === "canceled")) {
        // 自分で読み直すための cancel。呼び出し側 (book.js など) には「終わった」と見せない
        slog(u, `(${err})`);
        e.stopImmediatePropagation();
        return;
      }
      slog(u, `error:${err}`);
      // ネット専用の声・データ未導入などで読めなかった: voice を付けずに lang だけで 1 回だけ読み直す
      if (FIX && !SKIP_RETRY.includes(err) && !u.__kitNoVoiceTry && speakingU === u) {
        u.__kitNoVoiceTry = true;
        u.voice = null;
        u.lang = "ja-JP";
        slog(u, "retry-novoice");
        e.stopImmediatePropagation(); // まだ終わりではない (done や book.js の error は 読み直しの結果で来る)
        speakingUntil = Math.max(speakingUntil, performance.now() + 1500 + String(u.text).length * 260);
        setTimeout(() => { if (speakingU === u) speakNow(u); else { u.__kitEnded = true; } }, IS_ANDROID ? 250 : 60);
        return;
      }
      u.__kitEnded = true;
    });
  };
  // 放置・画面切替から戻ったとき 止まったままの読み上げを動かす (iOS 以外)
  document.addEventListener("visibilitychange", () => {
    if (!FIX || document.hidden || !hasSpeech) return;
    try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch (e) {}
  });
  const speechLogApi = {
    get: () => { const l = loadLog(); return { ua: uaSummary(), ...l, items: l.items.slice() }; },
    clear: () => { speechLog = { items: [] }; try { localStorage.removeItem(SPEECH_LOG_KEY); } catch (e) {} },
    flags: () => ({ fix: FIX, android: IS_ANDROID, ios: IS_IOS, noVoice, voice: jaVoice ? `${jaVoice.name} (${jaVoice.lang}${jaVoice.localService ? "" : ", net"})` : "(なし)" }),
  };

  // ---- ホームへ戻るボタン (長押しでのみ反応 = こどもの誤タップ対策) ----
  const HOLD_MS = 800;
  const homeButton = () => {
    const btn = document.createElement("button");
    btn.className = "kit-home";
    btn.setAttribute("aria-label", "ホームへ（ながおし）");
    btn.innerHTML = '<span class="kit-home-ring"></span><span class="kit-home-icon">🏠</span>';
    let timer = null;
    const start = (e) => {
      e.stopPropagation();
      btn.classList.add("holding");
      timer = setTimeout(() => {}, HOLD_MS); // 単体ページでは 行き先が無い
    };
    const cancel = () => {
      btn.classList.remove("holding");
      clearTimeout(timer);
    };
    btn.addEventListener("pointerdown", start);
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, cancel));
    document.body.appendChild(btn);
  };

  // ---- 「タップでスタート」の画面 (ゲームのページで自動的に出す) ----
  // iOS/Android は「指を ほとんど動かさずに はなした」ときだけ 音と読み上げを解禁する。
  // スワイプで始まってしまうと 音が出ないまま遊ぶことになるので、ちゃんとしたタップで はじめる。
  // 出さないページ: 絵本 (book.js の表紙がある) と <html data-nostart> のページ
  const TAP_MOVE = 16, TAP_MS = 1500;
  let startEl = null, startDown = null, started = false, ready = false; // started = ▶ を押した、ready = 音が立ち上がって 始まった
  const onStart = [];
  const inHome = (e) => e.target && e.target.closest && e.target.closest(".kit-home");
  const startBlock = (e) => {
    if (!startEl || inHome(e)) return;
    e.stopPropagation(); // kit と chip の解禁 (同じ document の capture) は動かしたまま、ゲームには届けない
    if (e.type === "pointerdown") {
      startDown = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    } else if (e.type === "pointerup" && startDown && e.pointerId === startDown.id) {
      const moved = Math.hypot(e.clientX - startDown.x, e.clientY - startDown.y);
      const tap = moved < TAP_MOVE && performance.now() - startDown.t < TAP_MS;
      startDown = null;
      if (tap) beginGame();
      else { startEl.classList.remove("nudge"); void startEl.offsetWidth; startEl.classList.add("nudge"); }
    }
  };
  ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "click", "mousedown", "mouseup"]
    .forEach((ev) => document.addEventListener(ev, startBlock, { capture: true }));
  // iPad は 最初に音を出すとき 音の出口の立ち上げで 1〜2 秒 画面ごと固まる (おとのテストで 1691ms を確認)。
  // ゲームの途中で固まらないよう、▶ を押したら 開始画面を出したまま 立ち上がるのを待ち、なめらかに動き出してから始める
  const warmUp = (done) => {
    const t0 = performance.now();
    let last = t0, smooth = 0;
    const f = (t) => {
      const gap = t - last;
      last = t;
      smooth = ctx && ctx.state === "running" && gap < 50 ? smooth + 1 : 0;
      if ((t - t0 > 700 && smooth >= 8) || t - t0 > 2500) return done();
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  };
  const beginGame = () => {
    if (started) return;
    started = true;
    unlockAudio(true);
    unlockSpeech();
    sfx.chime(7);
    const el = startEl;
    el.classList.add("warming");
    warmUp(() => {
      startEl = null; // ここまでは開始画面が タッチを受け止める
      ready = true;
      el.classList.add("gone");
      setTimeout(() => el.remove(), 300);
      onStart.splice(0).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    });
  };
  const startScreen = () => {
    const html = document.documentElement;
    // ?nostart は サムネイル撮影・検証用 (子どもの導線には出てこない)
    const noStart = /[?&]nostart\b/.test(location.search);
    if (noStart || html.hasAttribute("data-nostart")) {
      started = ready = true;
      if (noStart) { try { unlockAudio(true); } catch (e) {} }
      // 先に whenStarted で登録された開始処理を流す (?nostart の撮影・検証で ゲームが始まらなかった)
      onStart.splice(0).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
      return;
    }
    startEl = document.createElement("div");
    startEl.className = "kit-start";
    startEl.innerHTML = '<div class="kit-start-icon"></div><div class="kit-start-play"></div>';
    document.body.appendChild(startEl);
    // ページの 絵文字と色 (<html data-icon="🎹" data-color="#fff4e6">)
    startEl.querySelector(".kit-start-icon").textContent = html.dataset.icon || "🎹";
    if (html.dataset.color) startEl.style.setProperty("--kit-start-bg", html.dataset.color);
  };
  // ゲームから: はじまったら呼ぶ (もう始まっていれば すぐ呼ぶ)
  const whenStarted = (fn) => { if (ready) fn(); else onStart.push(fn); };

  const style = document.createElement("style");
  style.textContent = `
    .kit-start { position: fixed; inset: 0; z-index: 999; display: grid; place-items: center; align-content: center; gap: 4vmin;
      background: var(--kit-start-bg, #fff4e6); touch-action: none; transition: opacity .25s; }
    .kit-start.gone { opacity: 0; pointer-events: none; }
    .kit-start-icon { font-size: min(34vmin, 260px); line-height: 1; min-height: 1em; animation: kit-bob 2.4s ease-in-out infinite; }
    .kit-start-play { width: min(30vmin, 200px); aspect-ratio: 1; border-radius: 50%; background: #ff6b6b;
      box-shadow: 0 8px 0 rgba(0,0,0,.15); position: relative; animation: kit-breathe 1.8s ease-in-out infinite; }
    .kit-start-play::after { content: ""; position: absolute; left: 38%; top: 27%; border-style: solid;
      border-width: min(7.5vmin, 50px) 0 min(7.5vmin, 50px) min(12vmin, 80px); border-color: transparent transparent transparent #fff; }
    .kit-start.nudge .kit-start-play { animation: kit-nudge .45s ease; }
    .kit-start.warming .kit-start-play { animation: kit-breathe .6s ease-in-out infinite; opacity: .85; }
    @keyframes kit-bob { 50% { transform: translateY(-4%) rotate(4deg); } }
    @keyframes kit-breathe { 50% { transform: scale(1.06); } }
    @keyframes kit-nudge { 30% { transform: scale(1.15); } 60% { transform: scale(.95); } }
    .kit-home { position: fixed; top: 12px; left: 12px; z-index: 1000; width: 56px; height: 56px;
      border: none; border-radius: 50%; background: rgba(255,255,255,.7); font-size: 28px;
      display: grid; place-items: center; padding: 0; touch-action: none; }
    .kit-home-icon { position: relative; }
    .kit-home-ring { position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(#ff7aa2 var(--p, 0%), transparent 0); opacity: .8; }
    .kit-home.holding .kit-home-ring { animation: kit-hold ${HOLD_MS}ms linear forwards; }
    @property --p { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
    @keyframes kit-hold { to { --p: 100%; } }
  `;
  document.head.appendChild(style);

  // ---- ユーティリティ ----
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const COLORS = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#4dabf7", "#9775fa", "#f783ac"];

  // 画面いっぱいの canvas (高 DPI 対応)。resize 時に onResize(w, h) を呼ぶ
  const fullCanvas = (onResize) => {
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;touch-action:none;";
    document.body.appendChild(cv);
    const g = cv.getContext("2d");
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = innerWidth * dpr;
      cv.height = innerHeight * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      onResize && onResize(innerWidth, innerHeight);
    };
    addEventListener("resize", fit);
    fit();
    return { canvas: cv, g };
  };

  // VERSION は「おとのテスト」で新しい kit.js が動いているか確かめる用。kit.js を直したら上げる
  const VERSION = "2026-10-28a";
  const speechReady = () => speechUnlocked;
  window.Kit = { VERSION, audio, tone, sfx, say, speechReady, noteFreq, homeButton, rand, pick, COLORS, fullCanvas, whenStarted, get started() { return ready; }, sessionType, SESSION_KEY, speaking, speechLog: speechLogApi, SPEECH_LOG_KEY };

  // 単体ページなので 長押しの ホームボタンは 出さない
  document.addEventListener("DOMContentLoaded", () => { startScreen(); });
})();
