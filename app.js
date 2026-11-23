/* ورّاق — قارئ الكتب التفاعلي
 * PDF.js لقراءة الملف + StPageFlip لتقليب الصفحات.
 * كل شيء يعمل داخل المتصفح، ولا يُرفع الملف إلى أي خادم.
 */
(function () {
  'use strict';

  var PDFJS_VERSION = '3.11.174';
  var PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/';

  var PDFJS_OK = typeof window.pdfjsLib !== 'undefined';
  var FLIP_OK = typeof window.St !== 'undefined' && typeof window.St.PageFlip === 'function';

  if (PDFJS_OK) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.js';
  }

  /* ---------- عناصر الصفحة ---------- */
  function $(id) {
    return document.getElementById(id);
  }

  var els = {
    upload: $('upload-screen'),
    reader: $('reader-screen'),
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    bookHost: $('book-host'),
    bookTitle: $('book-title'),
    btnNew: $('btn-new'),
    btnDir: $('btn-dir'),
    dirLabel: $('dir-label'),
    btnSound: $('btn-sound'),
    btnFs: $('btn-fullscreen'),
    controls: $('controls'),
    btnPrev: $('btn-prev'),
    btnNext: $('btn-next'),
    slider: $('page-slider'),
    pageLabel: $('page-label'),
    loader: $('loader'),
    loaderText: $('loader-text'),
    toast: $('toast'),
    rotateTip: $('rotate-tip'),
    btnTipOk: $('btn-tip-ok'),
    btnTipOff: $('btn-tip-off'),
    stage: $('stage'),
    zoomOverlay: $('zoom-overlay'),
    btnZoomIn: $('btn-zoom-in'),
    btnZoomOut: $('btn-zoom-out'),
    btnZoomReset: $('btn-zoom-reset')
  };

  /* ---------- تخزين محلي آمن ---------- */
  var store = {
    get: function (key, fallback) {
      try {
        var v = window.localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch (e) {
        /* تجاهل */
      }
    }
  };

  /* ---------- الحالة ---------- */
  var SPINNER_HTML = '<div class="page-spinner"></div>';

  var state = {
    pdf: null,
    fileKey: '',
    numPages: 0,
    ratio: 1.414,          // ارتفاع/عرض الصفحة
    rtl: store.get('waraq:rtl', '1') === '1',
    sound: store.get('waraq:sound', '1') === '1',
    flip: null,
    order: [],             // فهرس صفحة المحرّك -> رقم صفحة الـ PDF (0-based) أو null لصفحة فارغة
    pageEls: [],
    rendered: new Set(),
    pending: new Set(),
    buildId: 0,
    targetWidth: 900,
    current: 0,            // أول صفحة ظاهرة (0-based)
    busy: false,
    zoom: 1,
    panX: 0,
    panY: 0
  };

  /* ---------- أدوات صغيرة ---------- */
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(resolve);
      });
    });
  }

  var toastTimer = null;
  function toast(message, type, ms) {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      els.toast.className = 'toast';
    }, ms || 4000);
  }

  function showLoader(text) {
    els.loaderText.textContent = text || 'جارٍ التحميل…';
    els.loader.hidden = false;
  }

  function hideLoader() {
    els.loader.hidden = true;
  }

  function showScreen(name) {
    els.upload.hidden = name !== 'upload';
    els.reader.hidden = name !== 'reader';
    if (name === 'upload') {
      document.title = 'ورّاق · اقلب صفحات كتابك';
    }
  }

  /* ---------- صوت تقليب الورق (يُولَّد برمجيًا بدون ملفات) ---------- */
  var audioCtx = null;

  function playFlipSound() {
    if (!state.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      var dur = 0.42;
      var sr = audioCtx.sampleRate;
      var length = Math.floor(sr * dur);
      var buffer = audioCtx.createBuffer(1, length, sr);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < length; i++) {
        var t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * t) * Math.pow(1 - t, 0.6);
      }

      var src = audioCtx.createBufferSource();
      src.buffer = buffer;

      var filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.7;
      var now = audioCtx.currentTime;
      filter.frequency.setValueAtTime(1600, now);
      filter.frequency.exponentialRampToValueAtTime(5200, now + dur);

      var gain = audioCtx.createGain();
      gain.gain.value = 0.32;

      src.connect(filter);
      filter.connect(gain);
      gain.connect(audioCtx.destination);
      src.start();
    } catch (e) {
      /* الصوت اختياري، نتجاهل أي خطأ */
    }
  }

  /* ---------- عرض صفحات الـ PDF ---------- */
  function estimateTargetWidth() {
    var w = els.bookHost.clientWidth || window.innerWidth;
    var h = els.bookHost.clientHeight || window.innerHeight;
    var portrait = w < 520;
    var pw = portrait ? w : w / 2;
    pw = Math.min(pw, 1400);
    if (pw * state.ratio > h) pw = h / state.ratio;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var base = clamp(Math.round(pw * dpr), 500, 1500);
    return Math.min(Math.round(base * state.zoom), 2400);
  }

  function renderIndex(i) {
    var el = state.pageEls[i];
    var orig = state.order[i];
    if (!el || orig === null || orig === undefined) return Promise.resolve();
    if (state.rendered.has(i) || state.pending.has(i)) return Promise.resolve();

    var bid = state.buildId;
    var pdf = state.pdf;
    if (!pdf) return Promise.resolve();

    state.pending.add(i);
    var tw = state.targetWidth;

    return pdf.getPage(orig + 1)
      .then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var scale = tw / base.width;
        var viewport = page.getViewport({ scale: scale });

        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        var ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
          try { page.cleanup(); } catch (e) { /* تجاهل */ }
          if (bid !== state.buildId || pdf !== state.pdf) {
            canvas.width = 0;
            canvas.height = 0;
            return;
          }
          var oldCanvas = el.querySelector('canvas');
          if (oldCanvas) {
            oldCanvas.width = 0;
            oldCanvas.height = 0;
          }
          el.textContent = '';
          el.appendChild(canvas);
          state.rendered.add(i);
        });
      })
      .catch(function (err) {
        if (bid !== state.buildId) return;
        if (window.console) console.warn('تعذّر عرض الصفحة', orig + 1, err);
        el.innerHTML = '<div class="page-error">تعذّر عرض هذه الصفحة</div>';
        state.rendered.add(i);
      })
      .then(function () {
        if (bid !== state.buildId) return;
        state.pending.delete(i);
        // تغيّرت الدقة المطلوبة أثناء الرسم (تكبير مثلًا): نعيد رسم الصفحات القريبة
        if (tw !== state.targetWidth && Math.abs(i - currentEngineIndex()) <= 2) {
          state.rendered.delete(i);
          renderIndex(i);
        }
      });
  }

  function releaseIndex(i) {
    var el = state.pageEls[i];
    if (!el) return;
    var canvas = el.querySelector('canvas');
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    el.innerHTML = SPINNER_HTML;
    state.rendered.delete(i);
  }

  // عند التكبير نرسم صفحات أقل (لكن بدقة أعلى) لتوفير الذاكرة
  function windowBounds(idx) {
    var zoomed = state.zoom > 1.05;
    return {
      lo: idx - (zoomed ? 1 : 4),
      hi: idx + (zoomed ? 2 : 5),
      kLo: idx - (zoomed ? 3 : 8),
      kHi: idx + (zoomed ? 4 : 9)
    };
  }

  function renderWindow(idx) {
    var n = state.pageEls.length;
    if (!n) return;
    var b = windowBounds(idx);
    var list = [];
    for (var i = Math.max(0, b.lo); i <= Math.min(n - 1, b.hi); i++) list.push(i);
    list.sort(function (a, b) {
      return Math.abs(a - idx) - Math.abs(b - idx);
    });
    list.forEach(function (i) { renderIndex(i); });

    Array.from(state.rendered).forEach(function (i) {
      if (i < b.kLo || i > b.kHi) releaseIndex(i);
    });
  }

  /* ---------- حالة الواجهة (رقم الصفحة، الأزرار) ---------- */
  function currentEngineIndex() {
    try {
      return state.flip ? state.flip.getCurrentPageIndex() : 0;
    } catch (e) {
      return 0;
    }
  }

  function visibleOriginalPages(idx) {
    var portrait = false;
    try {
      portrait = state.flip.getOrientation() === 'portrait';
    } catch (e) { /* تجاهل */ }

    var idxs = (portrait || idx === 0) ? [idx] : [idx, idx + 1];
    var result = [];
    idxs.forEach(function (i) {
      var o = state.order[i];
      if (o !== undefined && o !== null) result.push(o);
    });
    result.sort(function (a, b) { return a - b; });
    return result;
  }

  function syncUI() {
    if (!state.flip) return;
    var n = state.numPages;
    var vis = visibleOriginalPages(currentEngineIndex());
    if (!vis.length) return;

    state.current = vis[0];
    els.slider.value = String(vis[0] + 1);

    if (vis.length === 1) {
      els.pageLabel.textContent = 'صفحة ' + (vis[0] + 1) + ' من ' + n;
    } else {
      els.pageLabel.textContent = 'الصفحتان ' + (vis[0] + 1) + ' – ' + (vis[1] + 1) + ' من ' + n;
    }

    els.btnPrev.disabled = vis.indexOf(0) !== -1;
    els.btnNext.disabled = vis.indexOf(n - 1) !== -1;

    if (state.fileKey) store.set('waraq:pos:' + state.fileKey, state.current);
  }

  function onFlip() {
    renderWindow(currentEngineIndex());
    syncUI();
  }

  function updateDirUI() {
    els.dirLabel.textContent = state.rtl ? 'عربي' : 'English';
    els.controls.setAttribute('dir', state.rtl ? 'rtl' : 'ltr');
    els.slider.setAttribute('dir', state.rtl ? 'rtl' : 'ltr');
  }

  function updateSoundUI() {
    els.btnSound.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
  }

  /* ---------- بناء الكتاب ---------- */
  function destroyFlip() {
    if (state.flip) {
      try { state.flip.destroy(); } catch (e) { /* تجاهل */ }
      state.flip = null;
    }
    els.bookHost.innerHTML = '';
    state.rendered.clear();
    state.pending.clear();
    state.pageEls = [];
    state.order = [];
  }

  function buildOrder() {
    var n = state.numPages;
    var arr = [];
    for (var i = 0; i < n; i++) arr.push(i);

    if (state.rtl) {
      // نجعل العدد زوجيًا ليبقى الغلاف منفردًا، ثم نعكس الترتيب (كتاب عربي)
      if (n % 2 === 1) arr.push(null);
      arr.reverse();
    } else if (n < 2) {
      arr.push(null);
    }
    return arr;
  }

  function buildBook(startOrig) {
    var id = ++state.buildId;
    destroyFlip();
    resetZoom();

    var n = state.numPages;
    startOrig = clamp(startOrig || 0, 0, n - 1);

    state.order = buildOrder();
    state.targetWidth = estimateTargetWidth();

    var bookEl = document.createElement('div');
    bookEl.id = 'book';
    els.bookHost.appendChild(bookEl);

    var last = state.order.length - 1;
    state.pageEls = state.order.map(function (orig, i) {
      var d = document.createElement('div');
      d.className = 'page' + (orig === null ? ' page-blank' : '');
      if (i === 0 || i === last) d.setAttribute('data-density', 'hard');
      if (orig !== null) d.innerHTML = SPINNER_HTML;
      return d;
    });

    var startIdx = Math.max(0, state.order.indexOf(startOrig));
    var W = 500;
    var H = Math.round(W * state.ratio);

    var flip = new window.St.PageFlip(bookEl, {
      width: W,
      height: H,
      size: 'stretch',
      minWidth: 260,
      maxWidth: 1400,
      minHeight: 300,
      maxHeight: 2400,
      showCover: true,
      usePortrait: true,
      startPage: startIdx,
      drawShadow: true,
      maxShadowOpacity: 0.55,
      flippingTime: 900,
      mobileScrollSupport: false,
      swipeDistance: 30,
      showPageCorners: true,
      autoSize: true,
      useMouseEvents: true
    });

    flip.on('init', function () {
      if (id !== state.buildId) return;
      onFlip();
    });
    flip.on('flip', function () {
      if (id !== state.buildId) return;
      onFlip();
    });
    flip.on('changeOrientation', function () {
      if (id !== state.buildId) return;
      onFlip();
    });
    flip.on('changeState', function (e) {
      if (id !== state.buildId) return;
      if (e && e.data === 'flipping') playFlipSound();
    });

    flip.loadFromHTML(state.pageEls);
    state.flip = flip;

    els.slider.max = String(n);
    els.slider.min = '1';
    updateDirUI();

    renderWindow(startIdx);
    syncUI();
    window.setTimeout(function () {
      if (id === state.buildId) onFlip();
    }, 120);
  }

  /* ---------- التنقّل ---------- */
  function goNext() {
    if (!state.flip) return;
    if (state.rtl) state.flip.flipPrev(); else state.flip.flipNext();
  }

  function goPrev() {
    if (!state.flip) return;
    if (state.rtl) state.flip.flipNext(); else state.flip.flipPrev();
  }

  function goTo(orig) {
    if (!state.flip) return;
    var idx = state.order.indexOf(clamp(orig, 0, state.numPages - 1));
    if (idx < 0) return;
    renderWindow(idx);
    try {
      state.flip.flip(idx);
    } catch (e) {
      try { state.flip.turnToPage(idx); } catch (e2) { /* تجاهل */ }
    }
  }

  /* ---------- فتح وإغلاق الملفات ---------- */
  function closeBook() {
    destroyFlip();
    state.buildId++;
    var pdf = state.pdf;
    state.pdf = null;
    state.fileKey = '';
    state.numPages = 0;
    if (pdf) {
      try {
        var p = pdf.destroy();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* تجاهل */ }
    }
  }

  function openFile(file) {
    if (!file || state.busy) return;

    if (!PDFJS_OK || !FLIP_OK) {
      toast('تعذّر تحميل مكتبات القارئ. تأكد من اتصالك بالإنترنت ثم أعد تحميل الصفحة.', 'error', 6000);
      return;
    }

    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!isPdf) {
      toast('الرجاء اختيار ملف بصيغة PDF فقط.', 'error');
      return;
    }

    state.busy = true;
    showLoader('جارٍ فتح الكتاب…');

    var cancelled = false;
    var task = null;

    file.arrayBuffer()
      .then(function (buf) {
        closeBook();
        task = window.pdfjsLib.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: PDFJS_BASE + 'cmaps/',
          cMapPacked: true,
          standardFontDataUrl: PDFJS_BASE + 'standard_fonts/'
        });

        task.onPassword = function (updatePassword, reason) {
          hideLoader();
          var msg = reason === 2
            ? 'كلمة المرور غير صحيحة، حاول مرة أخرى:'
            : 'هذا الملف محمي بكلمة مرور. أدخلها لفتحه:';
          var pw = window.prompt(msg);
          if (pw === null || pw === '') {
            cancelled = true;
            task.destroy();
          } else {
            showLoader('جارٍ فتح الكتاب…');
            updatePassword(pw);
          }
        };

        return task.promise;
      })
      .then(function (pdf) {
        state.pdf = pdf;
        state.numPages = pdf.numPages;
        state.fileKey = file.name + '|' + file.size + '|' + pdf.numPages;

        return pdf.getPage(1).then(function (first) {
          var vp = first.getViewport({ scale: 1 });
          state.ratio = clamp(vp.height / vp.width, 0.5, 2.5);
          try { first.cleanup(); } catch (e) { /* تجاهل */ }
        });
      })
      .then(function () {
        var title = file.name.replace(/\.pdf$/i, '');
        els.bookTitle.textContent = title;
        document.title = 'ورّاق · ' + title;

        var saved = parseInt(store.get('waraq:pos:' + state.fileKey, '0'), 10);
        if (!isFinite(saved)) saved = 0;

        showScreen('reader');
        updateDirUI();
        updateSoundUI();

        return nextFrame().then(function () {
          buildBook(saved);
        });
      })
      .then(function () {
        hideLoader();
        state.busy = false;
        updateRotateTip();
        if ((!els.rotateTip || els.rotateTip.hidden) && store.get('waraq:hint', '0') !== '1') {
          store.set('waraq:hint', '1');
          window.setTimeout(function () {
            toast('اسحب زاوية الصفحة أو اضغط على حافتها لتقليبها 📖', 'info', 5000);
          }, 700);
        }
      })
      .catch(function (err) {
        if (window.console) console.error(err);
        closeBook();
        showScreen('upload');
        hideLoader();
        state.busy = false;
        if (cancelled) {
          toast('تم إلغاء فتح الملف.');
        } else {
          toast('تعذّر فتح هذا الملف. قد يكون تالفًا أو غير مدعوم.', 'error', 5000);
        }
      })
      .then(function () {
        els.fileInput.value = '';
      });
  }

  /* ---------- الأحداث ---------- */
  els.fileInput.addEventListener('change', function () {
    var f = els.fileInput.files && els.fileInput.files[0];
    if (f) openFile(f);
  });

  els.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  // السحب والإفلات على الصفحة كلها
  var dragDepth = 0;
  function hasFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  document.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    dragDepth++;
    els.dropzone.classList.add('drag');
  });

  document.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove('drag');
  });

  document.addEventListener('dragover', function (e) {
    if (hasFiles(e)) e.preventDefault();
  });

  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('drag');
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  els.btnNew.addEventListener('click', function () {
    closeBook();
    showScreen('upload');
    els.pageLabel.textContent = '';
    updateRotateTip();
  });

  els.btnPrev.addEventListener('click', goPrev);
  els.btnNext.addEventListener('click', goNext);

  els.slider.addEventListener('input', function () {
    els.pageLabel.textContent = 'صفحة ' + els.slider.value + ' من ' + state.numPages;
  });

  els.slider.addEventListener('change', function () {
    goTo(parseInt(els.slider.value, 10) - 1);
  });

  els.btnDir.addEventListener('click', function () {
    if (!state.pdf || state.busy) return;
    var keep = state.current;
    state.rtl = !state.rtl;
    store.set('waraq:rtl', state.rtl ? '1' : '0');
    updateDirUI();
    buildBook(keep);
    toast(state.rtl
      ? 'كتاب عربي: يبدأ الغلاف من اليمين.'
      : 'كتاب إنجليزي: يبدأ الغلاف من اليسار.');
  });

  els.btnSound.addEventListener('click', function () {
    state.sound = !state.sound;
    store.set('waraq:sound', state.sound ? '1' : '0');
    updateSoundUI();
    if (state.sound) playFlipSound();
  });

  if (document.documentElement.requestFullscreen) {
    els.btnFs.addEventListener('click', function () {
      try {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          var p = document.documentElement.requestFullscreen();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        }
      } catch (e) { /* تجاهل */ }
    });
  } else {
    els.btnFs.hidden = true;
  }

  document.addEventListener('keydown', function (e) {
    if (els.reader.hidden || !state.flip) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (state.rtl) goNext(); else goPrev();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (state.rtl) goPrev(); else goNext();
        break;
      case 'Home':
        e.preventDefault();
        goTo(0);
        break;
      case 'End':
        e.preventDefault();
        goTo(state.numPages - 1);
        break;
      case '+':
      case '=':
        e.preventDefault();
        stepZoom(1);
        break;
      case '-':
      case '_':
        e.preventDefault();
        stepZoom(-1);
        break;
      case '0':
        e.preventDefault();
        setZoom(1, true, 0, 0);
        break;
      default:
        break;
    }
  });

  /* ---------- التكبير والتصغير ---------- */
  var ZOOM_MIN = 1;
  var ZOOM_MAX = 4;
  var ZOOM_STEPS = [1, 1.5, 2, 3, 4];
  var zoomHinted = false;
  var refreshTimer = null;

  // مركز منطقة الكتاب قبل أي تحويل (بإحداثيات الشاشة)
  function hostCenter() {
    var sr = els.stage.getBoundingClientRect();
    return {
      x: sr.left + els.bookHost.offsetLeft + els.bookHost.offsetWidth / 2,
      y: sr.top + els.bookHost.offsetTop + els.bookHost.offsetHeight / 2
    };
  }

  function applyTransform(animate) {
    els.bookHost.classList.toggle('animating', !!animate);
    els.bookHost.style.transform = state.zoom === 1
      ? ''
      : 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
  }

  function clampPan() {
    var mx = Math.max(0, (state.zoom - 1) * els.bookHost.offsetWidth / 2);
    var my = Math.max(0, (state.zoom - 1) * els.bookHost.offsetHeight / 2);
    state.panX = clamp(state.panX, -mx, mx);
    state.panY = clamp(state.panY, -my, my);
  }

  function updateZoomUI() {
    var z = state.zoom;
    if (els.zoomOverlay) els.zoomOverlay.hidden = z === 1;
    if (els.btnZoomReset) els.btnZoomReset.textContent = Math.round(z * 100) + '%';
    if (els.btnZoomIn) els.btnZoomIn.disabled = z >= ZOOM_MAX - 0.001;
    if (els.btnZoomOut) els.btnZoomOut.disabled = z <= ZOOM_MIN;
  }

  // نعيد رسم الصفحات بدقة تناسب مستوى التكبير الجديد
  function refreshResolution() {
    if (!state.flip) return;
    var nw = estimateTargetWidth();
    if (nw > state.targetWidth * 1.2 || nw < state.targetWidth * 0.7) {
      state.targetWidth = nw;
      var idx = currentEngineIndex();
      var b = windowBounds(idx);
      Array.from(state.rendered).forEach(function (i) {
        if (i >= b.lo && i <= b.hi) state.rendered.delete(i);
        else releaseIndex(i);
      });
      renderWindow(idx);
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshResolution, 220);
  }

  // rx, ry: نقطة التكبير بالنسبة لمركز الكتاب (بكسل الشاشة)
  function setZoom(z, animate, rx, ry) {
    z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (z < 1.05) z = 1;
    rx = rx || 0;
    ry = ry || 0;
    var f = z / state.zoom;
    state.panX = rx - f * (rx - state.panX);
    state.panY = ry - f * (ry - state.panY);
    state.zoom = z;
    if (z === 1) {
      state.panX = 0;
      state.panY = 0;
    }
    clampPan();
    applyTransform(animate);
    updateZoomUI();
    scheduleRefresh();

    if (z > 1 && !zoomHinted) {
      zoomHinted = true;
      toast('اسحب لتحريك الصفحة، وانقر مرتين للعودة إلى 100%', 'info', 4500);
    }
  }

  function resetZoom() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyTransform(false);
    updateZoomUI();
  }

  function stepZoom(dir) {
    var z = state.zoom;
    var target = z;
    var i;
    if (dir > 0) {
      for (i = 0; i < ZOOM_STEPS.length; i++) {
        if (ZOOM_STEPS[i] > z + 0.01) { target = ZOOM_STEPS[i]; break; }
      }
    } else {
      for (i = ZOOM_STEPS.length - 1; i >= 0; i--) {
        if (ZOOM_STEPS[i] < z - 0.01) { target = ZOOM_STEPS[i]; break; }
      }
    }
    setZoom(target, true, 0, 0);
  }

  if (els.btnZoomIn) els.btnZoomIn.addEventListener('click', function () { stepZoom(1); });
  if (els.btnZoomOut) els.btnZoomOut.addEventListener('click', function () { stepZoom(-1); });
  if (els.btnZoomReset) els.btnZoomReset.addEventListener('click', function () { setZoom(1, true, 0, 0); });

  // عجلة الماوس / قرص لوحة اللمس
  if (els.stage) {
    els.stage.addEventListener('wheel', function (e) {
      if (!state.flip) return;
      e.preventDefault();
      var dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      var f = Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016));
      var c = hostCenter();
      setZoom(state.zoom * f, false, e.clientX - c.x, e.clientY - c.y);
    }, { passive: false });
  }

  // تحريك الصفحة بالسحب، والقرص بإصبعين، والنقر المزدوج للعودة (يعمل عند التكبير فقط)
  var pointers = {};
  var lastMid = null;
  var lastDist = 0;
  var tapInfo = null;
  var lastTap = { t: 0, x: 0, y: 0 };

  function pointerList() {
    return Object.keys(pointers).map(function (k) { return pointers[k]; });
  }

  function pDist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  }

  function pMid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function resetGestureRef() {
    var l = pointerList();
    if (l.length >= 2) {
      lastDist = pDist(l[0], l[1]);
      lastMid = pMid(l[0], l[1]);
    } else if (l.length === 1) {
      lastDist = 0;
      lastMid = { x: l[0].x, y: l[0].y };
    } else {
      lastDist = 0;
      lastMid = null;
    }
  }

  function endPointer(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    if (pointerList().length === 0) {
      els.zoomOverlay.classList.remove('dragging');
      var now = Date.now();
      if (tapInfo && !tapInfo.moved && now - tapInfo.t < 300) {
        if (now - lastTap.t < 320 &&
            Math.abs(e.clientX - lastTap.x) + Math.abs(e.clientY - lastTap.y) < 40) {
          lastTap.t = 0;
          setZoom(1, true, 0, 0);
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      }
      tapInfo = null;
    }
    resetGestureRef();
  }

  if (els.zoomOverlay) {
    els.zoomOverlay.addEventListener('pointerdown', function (e) {
      try { els.zoomOverlay.setPointerCapture(e.pointerId); } catch (err) { /* تجاهل */ }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pointerList().length === 1) {
        tapInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
        els.zoomOverlay.classList.add('dragging');
      } else {
        tapInfo = null;
      }
      resetGestureRef();
    });

    els.zoomOverlay.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (tapInfo && Math.abs(e.clientX - tapInfo.x) + Math.abs(e.clientY - tapInfo.y) > 10) {
        tapInfo.moved = true;
      }

      var l = pointerList();
      if (l.length >= 2) {
        var d = pDist(l[0], l[1]);
        var m = pMid(l[0], l[1]);
        if (lastDist > 0 && lastMid) {
          var c = hostCenter();
          state.panX += m.x - lastMid.x;
          state.panY += m.y - lastMid.y;
          setZoom(state.zoom * (d / lastDist), false, m.x - c.x, m.y - c.y);
        }
        lastDist = d;
        lastMid = m;
      } else if (l.length === 1 && lastMid) {
        state.panX += l[0].x - lastMid.x;
        state.panY += l[0].y - lastMid.y;
        lastMid = { x: l[0].x, y: l[0].y };
        clampPan();
        applyTransform(false);
      }
    });

    els.zoomOverlay.addEventListener('pointerup', endPointer);
    els.zoomOverlay.addEventListener('pointercancel', endPointer);
  }

  /* ---------- اقتراح قلب الهاتف + التكيّف مع تغيّر الاتجاه ---------- */
  var tipDismissed = false;

  function isPhonePortrait() {
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return !!coarse && window.innerWidth < 700 && window.innerHeight > window.innerWidth;
  }

  function updateRotateTip() {
    if (!els.rotateTip) return;
    var show = !els.reader.hidden &&
      !tipDismissed &&
      store.get('waraq:rotateTip', '1') === '1' &&
      isPhonePortrait();
    els.rotateTip.hidden = !show;
  }

  if (els.btnTipOk) els.btnTipOk.addEventListener('click', function () {
    tipDismissed = true;
    updateRotateTip();
  });

  if (els.btnTipOff) els.btnTipOff.addEventListener('click', function () {
    store.set('waraq:rotateTip', '0');
    tipDismissed = true;
    updateRotateTip();
    toast('تم إيقاف التنبيه.');
  });

  var viewportTimer = null;
  function onViewportChange() {
    updateRotateTip();
    window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(function () {
      if (!state.flip) return;
      clampPan();
      applyTransform(false);
      refreshResolution();
    }, 350);
  }

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  /* ---------- زر التثبيت ورسائل التشخيص ---------- */
  var installBox = $('install-box');
  var btnInstall = $('btn-install');
  var installHint = $('install-hint');
  var deferredPrompt = null;

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function showInstallBox(hint, withButton) {
    if (!installBox || !btnInstall || !installHint) return;
    if (isStandalone()) return;
    installHint.textContent = hint || '';
    installHint.hidden = !hint;
    btnInstall.hidden = !withButton;
    installBox.hidden = false;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBox('', true);
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (installBox) installBox.hidden = true;
    toast('تم تثبيت التطبيق 🎉');
  });

  if (btnInstall) btnInstall.addEventListener('click', function () {
    if (!deferredPrompt) return;
    var p = deferredPrompt;
    deferredPrompt = null;
    p.prompt();
    if (p.userChoice && typeof p.userChoice.then === 'function') {
      p.userChoice.then(function () { if (installBox) installBox.hidden = true; });
    }
  });

  window.setTimeout(function () {
    if (isStandalone() || deferredPrompt) return;
    var ua = navigator.userAgent || '';
    var secure = window.isSecureContext || window.location.hostname === 'localhost';

    if (!secure) {
      showInstallBox('التثبيت يحتاج أن يُفتح الموقع عبر رابط https مثل GitHub Pages، وليس من ملف على الجهاز.', false);
      return;
    }
    if (/FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|MicroMessenger|Telegram/i.test(ua)) {
      showInstallBox('أنت تفتح الموقع داخل متصفح تطبيق آخر. افتح الرابط في Chrome أو Safari ثم ثبّته.', false);
      return;
    }
    var isIOS = /iPhone|iPad|iPod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      showInstallBox('للتثبيت على الآيفون: افتح الموقع في Safari، ثم اضغط زر المشاركة، ثم «إضافة إلى الشاشة الرئيسية».', false);
      return;
    }
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      showInstallBox('للتثبيت: افتح قائمة المتصفح ⋮ واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».', false);
    }
  }, 2500);

  /* ---------- تسجيل Service Worker (للتثبيت والعمل بدون إنترنت) ---------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        /* التثبيت اختياري، نتجاهل أي فشل */
      });
    });
  }

  /* ---------- بداية التشغيل ---------- */
  updateDirUI();
  updateSoundUI();

  if (!PDFJS_OK || !FLIP_OK) {
    toast('تعذّر تحميل مكتبات القارئ من الإنترنت. تأكد من اتصالك ثم أعد تحميل الصفحة.', 'error', 8000);
  }
})();
