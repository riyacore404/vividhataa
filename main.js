/* ═══════════════════════════════════════════════════════════
   UCHIHA ITACHIth — scroll-scrubbed frames + mouse-tracked eyes
   ═══════════════════════════════════════════════════════════ */

const MAIN_COUNT = 71;
const pad = n => String(n).padStart(3, '0');

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/* fade in over [a,b], hold, fade out over [c,d] */
const window4 = (p, a, b, c, d) =>
  p < a || p > d ? 0 : p < b ? (p - a) / (b - a) : p > c ? 1 - (p - c) / (d - c) : 1;

/* ───────────────────────── preload ───────────────────────── */
const mainFrames = [];
let loaded = 0;
const total = MAIN_COUNT;
const LOADER_MIN_TIME = 3000; // 3 seconds
const loaderStartTime = performance.now();

const loaderEl = document.getElementById('loader');
const loaderFill = document.getElementById('loaderFill');
const loaderPct = document.getElementById('loaderPct');

let realAssetPct = 0;
function load(src, bucket, index) {
  return new Promise(res => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = img.onerror = () => {
      bucket[index] = img;
      loaded++;
      realAssetPct = (loaded / total) * 100;
      res();
    };
    img.src = src;
  });
}

const jobs = [];
for (let i = 1; i <= MAIN_COUNT; i++) jobs.push(load(`frames/main/frame_${pad(i)}.webp`, mainFrames, i - 1));

function animateLoader() {
  if (!loaderFill || !loaderPct) {
    document.body.classList.add('ready');
    return;
  }
  const elapsed = performance.now() - loaderStartTime;
  const timePct = (elapsed / LOADER_MIN_TIME) * 100;
  const displayPct = Math.min(100, Math.min(timePct, Math.max(timePct * 0.9, realAssetPct)));

  if (loaderFill) loaderFill.style.width = displayPct.toFixed(1) + '%';
  if (loaderPct) loaderPct.textContent = String(Math.round(displayPct)).padStart(2, '0');

  if (elapsed < LOADER_MIN_TIME || loaded < total) {
    requestAnimationFrame(animateLoader);
  } else {
    if (loaderFill) loaderFill.style.width = '100%';
    if (loaderPct) loaderPct.textContent = '100';
    setTimeout(() => {
      if (loaderEl) loaderEl.classList.add('done');
      document.body.classList.add('ready');
      resizeAll();
      setTimeout(() => { if (loaderEl) loaderEl.style.display = 'none'; }, 1100);
    }, 300);
  }
}
requestAnimationFrame(animateLoader);

/* ─────────────────── canvas cover-draw helper ─────────────────── */
/* Keeps the backing store in step with the element's real box. Uses
   offsetWidth/Height, not getBoundingClientRect, because these canvases carry
   CSS transforms and a transformed rect would poison the size. */
function fitCanvas(canvas) {
  if (!canvas) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round((canvas.offsetWidth || 0) * dpr);
  const h = Math.round((canvas.offsetHeight || 0) * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  return canvas.getContext ? canvas.getContext('2d') : null;
}

/* cheap per-frame guard: layout can change without a resize event
   (mobile URL bar collapse, zoom, devtools) */
function syncSize(canvas) {
  if (!canvas) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round((canvas.offsetWidth || 0) * dpr);
  const h = Math.round((canvas.offsetHeight || 0) * dpr);
  return canvas.width !== w || canvas.height !== h;
}

/* Fills the canvas, but never crops the sides harder than `maxUp` allows —
   so on tall/narrow screens the composition (a face, two eyes) survives
   instead of zooming into a nostril. */
function drawCover(ctx, img, cw, ch, maxUp = 2.0) {
  if (!img || !img.naturalWidth) return false;
  const ir = img.naturalWidth / img.naturalHeight;
  let w = cw, h = cw / ir;                 // start by fitting the width
  if (h < ch) {                            // needs to grow to cover height
    const s = Math.min(ch / h, maxUp);
    w *= s; h *= s;
  }
  ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  return true;
}

/* ═══════════════════════════════════════════════════════════
   GHOST CURSOR
   Port of reactbits.dev/animations/ghost-cursor (three.js) to raw WebGL —
   same fbm-smoke fragment shader and trail ring-buffer, minus the dependency.
   Bloom/film-grain passes are dropped; the page already grains globally.
   ═══════════════════════════════════════════════════════════ */
function createGhostCursor(canvas, opts = {}) {
  if (!canvas) return { resize() { }, move() { }, render() { }, ok: false };
  const TRAIL = opts.trailLength ?? 28;
  const INERTIA = opts.inertia ?? 0.5;
  const MAX_DPR = opts.maxDevicePixelRatio ?? 0.45;
  const BUDGET = opts.targetPixels ?? 4.2e5;
  const BRIGHT = opts.brightness ?? 1.45;
  const EDGE = opts.edgeIntensity ?? 0.35;
  const FADE_DELAY = opts.fadeDelayMs ?? 900;
  const FADE_DUR = opts.fadeDurationMs ?? 1400;
  const rgb = hexToRgb(opts.color ?? '#ff2b2b');

  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'high-performance'
  });
  if (!gl) return { resize() { }, move() { }, render() { }, ok: false };

  const VERT = `
    attribute vec2 aPos;
    void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  /* fragment shader: verbatim from the react-bits component */
  const FRAG = `
    precision highp float;
    #define MAX_TRAIL_LENGTH ${TRAIL}

    uniform float iTime;
    uniform vec3  iResolution;
    uniform vec2  iMouse;
    uniform vec2  iPrevMouse[MAX_TRAIL_LENGTH];
    uniform float iOpacity;
    uniform float iScale;
    uniform vec3  iBaseColor;
    uniform float iBrightness;
    uniform float iEdgeIntensity;

    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7))) * 43758.5453123); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f *= f * (3. - 2. * f);
      return mix(mix(hash(i + vec2(0.,0.)), hash(i + vec2(1.,0.)), f.x),
                 mix(hash(i + vec2(0.,1.)), hash(i + vec2(1.,1.)), f.x), f.y);
    }
    float fbm(vec2 p){
      float v = 0.0;
      float a = 0.5;
      mat2 m = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
      for(int i=0;i<5;i++){
        v += a * noise(p);
        p = m * p * 2.0;
        a *= 0.5;
      }
      return v;
    }
    vec3 tint1(vec3 base){ return mix(base, vec3(1.0), 0.15); }
    vec3 tint2(vec3 base){ return mix(base, vec3(0.8, 0.9, 1.0), 0.25); }

    vec4 blob(vec2 p, vec2 mousePos, float intensity, float activity) {
      vec2 q = vec2(fbm(p * iScale + iTime * 0.1), fbm(p * iScale + vec2(5.2,1.3) + iTime * 0.1));
      vec2 r = vec2(fbm(p * iScale + q * 1.5 + iTime * 0.15), fbm(p * iScale + q * 1.5 + vec2(8.3,2.8) + iTime * 0.15));

      float smoke = fbm(p * iScale + r * 0.8);
      float radius = 0.5 + 0.3 * (1.0 / iScale);
      float distFactor = 1.0 - smoothstep(0.0, radius * activity, length(p - mousePos));
      float alpha = pow(smoke, 2.5) * distFactor;

      vec3 c1 = tint1(iBaseColor);
      vec3 c2 = tint2(iBaseColor);
      vec3 color = mix(c1, c2, sin(iTime * 0.5) * 0.5 + 0.5);

      return vec4(color * alpha * intensity, alpha * intensity);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy / iResolution.xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);
      vec2 mouse = (iMouse * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);

      vec3 colorAcc = vec3(0.0);
      float alphaAcc = 0.0;

      vec4 b = blob(uv, mouse, 1.0, iOpacity);
      colorAcc += b.rgb;
      alphaAcc += b.a;

      for (int i = 0; i < MAX_TRAIL_LENGTH; i++) {
        vec2 pm = (iPrevMouse[i] * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0);
        float t = 1.0 - float(i) / float(MAX_TRAIL_LENGTH);
        t = pow(t, 2.0);
        if (t > 0.01) {
          vec4 bt = blob(uv, pm, t * 0.8, iOpacity);
          colorAcc += bt.rgb;
          alphaAcc += bt.a;
        }
      }

      colorAcc *= iBrightness;

      vec2 uv01 = gl_FragCoord.xy / iResolution.xy;
      float edgeDist = min(min(uv01.x, 1.0 - uv01.x), min(uv01.y, 1.0 - uv01.y));
      float distFromEdge = clamp(edgeDist * 2.0, 0.0, 1.0);
      float k = clamp(iEdgeIntensity, 0.0, 1.0);
      float edgeMask = mix(1.0 - k, 1.0, distFromEdge);

      float outAlpha = clamp(alphaAcc * iOpacity * edgeMask, 0.0, 1.0);
      gl_FragColor = vec4(colorAcc, outAlpha);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('ghost shader:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return { resize() { }, move() { }, render() { }, ok: false };

  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { resize() { }, move() { }, render() { }, ok: false };
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = n => gl.getUniformLocation(prog, n);
  const uTime = U('iTime'), uRes = U('iResolution'), uMouse = U('iMouse'),
    uPrev = U('iPrevMouse[0]'), uOpacity = U('iOpacity'), uScale = U('iScale'),
    uColor = U('iBaseColor'), uBright = U('iBrightness'), uEdge = U('iEdgeIntensity');

  gl.uniform3f(uColor, rgb[0], rgb[1], rgb[2]);
  gl.uniform1f(uBright, BRIGHT);
  gl.uniform1f(uEdge, EDGE);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  /* trail ring buffer, exactly as the original */
  const trail = new Float32Array(TRAIL * 2).fill(0.5);
  const flat = new Float32Array(TRAIL * 2).fill(0.5);
  let head = 0;

  const target = { x: 0.5, y: 0.5 };
  const cur = { x: 0.5, y: 0.5 };
  const vel = { x: 0, y: 0 };
  let pointerActive = false;
  let lastMove = performance.now();
  let fade = 0;
  const t0 = performance.now();

  function resize() {
    const cssW = canvas.offsetWidth, cssH = canvas.offsetHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const need = cssW * cssH * dpr * dpr;
    const s = need <= BUDGET ? 1 : Math.max(0.4, Math.min(1, Math.sqrt(BUDGET / Math.max(1, need))));
    const pr = dpr * s;
    const w = Math.max(1, Math.floor(cssW * pr));
    const h = Math.max(1, Math.floor(cssH * pr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.uniform3f(uRes, w, h, 1);
    // matches calculateScale(): smaller side vs a 600px baseline
    const base = Math.min(Math.max(1, cssW), Math.max(1, cssH));
    gl.uniform1f(uScale, Math.max(0.5, Math.min(2.0, base / 600)));
  }

  /* x,y normalised to the element box; y is flipped for GL */
  function move(x, y, active = true) {
    target.x = clamp(x); target.y = clamp(1 - y);
    pointerActive = active;
    if (active) { lastMove = performance.now(); fade = 1; }
  }
  function leave() { pointerActive = false; lastMove = performance.now(); }

  function render() {
    const now = performance.now();

    if (pointerActive) {
      vel.x = target.x - cur.x; vel.y = target.y - cur.y;
      cur.x = target.x; cur.y = target.y;
      fade = 1;
    } else {
      vel.x *= INERTIA; vel.y *= INERTIA;
      if (vel.x * vel.x + vel.y * vel.y > 1e-6) { cur.x += vel.x; cur.y += vel.y; }
      const dt = now - lastMove;
      if (dt > FADE_DELAY) fade = Math.max(0, 1 - Math.min(1, (dt - FADE_DELAY) / FADE_DUR));
    }
    if (fade <= 0.001 && !pointerActive) { gl.clear(gl.COLOR_BUFFER_BIT); return false; }

    head = (head + 1) % TRAIL;
    trail[head * 2] = cur.x; trail[head * 2 + 1] = cur.y;
    for (let i = 0; i < TRAIL; i++) {
      const src = ((head - i) % TRAIL + TRAIL) % TRAIL;
      flat[i * 2] = trail[src * 2];
      flat[i * 2 + 1] = trail[src * 2 + 1];
    }

    gl.useProgram(prog);
    gl.uniform1f(uTime, (now - t0) / 1000);
    gl.uniform2f(uMouse, cur.x, cur.y);
    gl.uniform2fv(uPrev, flat);
    gl.uniform1f(uOpacity, fade);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  return { resize, move, leave, render, ok: true };
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ═══════════════════ ACT I — scroll scrub ═══════════════════ */
const scrubSection = document.getElementById('scrub');
const mainCanvas = document.getElementById('mainCanvas');
const scrubGlow = document.getElementById('scrubGlow');
const titleblock = document.getElementById('titleblock');
const phases = [...document.querySelectorAll('.phase')];
let mainCtx = mainCanvas ? fitCanvas(mainCanvas) : null;

/* frame index is lerped toward the scroll target → butter-smooth both ways */
let frameTarget = 0, frameShown = 0, lastDrawn = -1;
let scrubProgress = 0;

function readScrub() {
  if (!scrubSection) return;
  const rect = scrubSection.getBoundingClientRect();
  const dist = scrubSection.offsetHeight - window.innerHeight;
  scrubProgress = clamp(-rect.top / (dist || 1));
  frameTarget = scrubProgress * (MAIN_COUNT - 1);
}

/* caption choreography */
/* tuned to the footage: 1-13 closed · 14-24 opening · 25-52 sharingan · 53-71 crows */
const PHASE_WINDOWS = [
  [0.13, 0.17, 0.21, 0.25],   // 静寂
  [0.27, 0.31, 0.37, 0.42],   // 覚醒
  [0.45, 0.49, 0.63, 0.69],   // 写輪眼
  [0.72, 0.76, 0.82, 0.86],   // 烏
];

function paintOverlays(p) {
  phases.forEach((el, i) => {
    const o = window4(p, ...PHASE_WINDOWS[i]);
    el.style.opacity = o.toFixed(3);
    el.style.setProperty('--y', `${((1 - o) * 34).toFixed(1)}px`);
    el.style.filter = `blur(${((1 - o) * 7).toFixed(2)}px)`;
  });

  const t1 = window4(p, -0.10, -0.05, 0.07, 0.13);
  const t2 = window4(p, 0.87, 0.93, 1.05, 1.10);
  const t = Math.max(t1, t2);

  titleblock.style.opacity = t.toFixed(3);
  titleblock.style.transform = `translate(-50%, calc(-50% + ${((1 - t) * 40).toFixed(1)}px)) scale(${(0.97 + t * 0.03).toFixed(3)})`;
  titleblock.style.letterSpacing = `${((1 - t) * 0.12).toFixed(3)}em`;

  // red bloom ramps up as the sharingan ignites
  scrubGlow.style.opacity = (clamp((p - 0.32) / 0.16) * 0.85).toFixed(3);
}

/* ═════════════════ crow-feather particle field ═════════════════ */
const featherCanvas = document.getElementById('featherCanvas');
let fCtx = fitCanvas(featherCanvas);
const feathers = [];

function seedFeathers() {
  feathers.length = 0;
  const n = window.innerWidth < 820 ? 28 : 54;
  for (let i = 0; i < n; i++) {
    feathers.push({
      x: Math.random(), y: Math.random(),
      s: 0.35 + Math.random() * 1.15,      // scale
      vx: 0.18 + Math.random() * 0.5,      // drift speed
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.02,
      sway: Math.random() * Math.PI * 2,
      a: 0.16 + Math.random() * 0.5,
    });
  }
}
seedFeathers();

function drawFeather(ctx, f, w, h, dir, intensity) {
  const x = f.x * w, y = f.y * h;
  const len = 22 * f.s * (w / 1280 + 0.55);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(f.rot + Math.sin(f.sway) * 0.35 + (dir < 0 ? Math.PI : 0));
  ctx.globalAlpha = f.a * intensity;
  ctx.fillStyle = '#0d0d10';
  ctx.strokeStyle = 'rgba(255,43,43,.55)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-len, 0);
  ctx.quadraticCurveTo(-len * 0.15, -len * 0.42, len, 0);
  ctx.quadraticCurveTo(-len * 0.15, len * 0.42, -len, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/* ═════════════════ AMATERASU — black flame hem ═════════════════ */
/* Amaterasu burns black, so the fire can't be read by its fill — it's read by
   the crimson rim around it. Every tongue is drawn twice: a hot additive halo
   first, then a slightly smaller pure-black core stamped on top. What survives
   between the two radii is the burning edge. */
const amaCanvas = document.getElementById('amaterasuCanvas');
let amaCtx = fitCanvas(amaCanvas);
const flames = [];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let amaPainted = false;

function seedFlames() {
  flames.length = 0;
  /* one tongue every ~26 css px, so the hem stays dense on any width */
  const n = Math.max(22, Math.round(window.innerWidth / 26));
  for (let i = 0; i < n; i++) {
    const depth = Math.random();                    // 0 far · 1 near
    flames.push({
      x: (i + Math.random() * 1.1) / n,             // 0..1 across the band
      depth,
      drift: (Math.random() - 0.5) * 0.05,          // lateral wander per second
      /* far tongues run tall and thin, near ones squat and fat — capped under
         1 so no tip is ever cut off flat by the canvas edge */
      h: (0.42 + Math.random() * 0.5) * (1.15 - depth * 0.35),
      w: (0.34 + Math.random() * 0.6) * (0.7 + depth * 0.7),
      speed: 0.7 + Math.random() * 1.25,            // lick rate
      lean: (Math.random() - 0.5) * 0.5,            // steady tilt off vertical
      phase: Math.random() * Math.PI * 2,
      seed: Math.random() * 100,
    });
  }
  /* far tongues first, so a near black body can eclipse a distant rim */
  flames.sort((a, b) => a.depth - b.depth);
}
seedFlames();

/* one tongue = a stack of shrinking blobs riding a leaning, wobbling spine */
function flameBlob(f, i, BLOBS, w, h, p, tall, wide) {
  const u = i / (BLOBS - 1);                        // 0 base → 1 tip
  const baseX = (f.x + Math.sin(p * 0.4 + f.seed) * f.drift) * w;
  return {
    u,
    x: baseX + (f.lean * u + Math.sin(p * 1.7 + u * 3.4 + f.seed) * 0.6 * u) * wide,
    /* the spine crowds its blobs toward the tip, which sharpens the taper */
    y: h - Math.pow(u, 0.82) * tall,
    r: wide * (1 - u * 0.78) + wide * 0.06,
  };
}

function drawFlame(ctx, f, w, h, t) {
  const p = f.phase + t * f.speed;
  const lick = 0.74 + Math.sin(p) * 0.18 + Math.sin(p * 2.9 + f.seed) * 0.08;
  const tall = h * f.h * lick;
  const wide = h * 0.24 * f.w;
  const near = 0.55 + f.depth * 0.45;               // distance dims everything
  const BLOBS = 9;

  /* pass 1 — the halo. Hot only near the root; the tip burns out to nothing. */
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < BLOBS; i++) {
    const b = flameBlob(f, i, BLOBS, w, h, p, tall, wide);
    const r = b.r * 1.28;
    const heat = Math.pow(1 - b.u, 1.6) * 0.9 + 0.06;
    const g = ctx.createRadialGradient(b.x, b.y, r * 0.45, b.x, b.y, r);
    g.addColorStop(0, `rgba(214,32,44,${0.42 * heat * near})`);
    g.addColorStop(0.55, `rgba(126,12,30,${0.2 * heat * near})`);
    g.addColorStop(1, 'rgba(46,0,14,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* pass 2 — the black body, punched inside the halo */
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < BLOBS; i++) {
    const b = flameBlob(f, i, BLOBS, w, h, p, tall, wide);
    const a = (0.97 - b.u * 0.42) * near;           // tips thin out into smoke
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, `rgba(3,2,4,${a})`);
    g.addColorStop(0.62, `rgba(6,3,8,${a * 0.8})`);
    g.addColorStop(1, 'rgba(9,5,11,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* a few sparks shed off the tips — cheap, and they sell the fire as alive */
function drawEmbers(ctx, w, h, t) {
  ctx.globalCompositeOperation = 'lighter';
  const n = 14;
  for (let i = 0; i < n; i++) {
    const s = i * 12.9898;
    const life = (t * (0.22 + (i % 5) * 0.05) + i / n) % 1;
    const x = ((Math.sin(s) * 0.5 + 0.5) + Math.sin(t * 0.6 + s) * 0.02) * w;
    const y = h - life * h * 0.95;
    const a = Math.sin(life * Math.PI) * 0.5;
    const r = h * 0.018 * (1.4 - life * 0.6);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,74,60,${a})`);
    g.addColorStop(1, 'rgba(120,10,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function paintAmaterasu(t) {
  const w = amaCanvas.width, h = amaCanvas.height;
  amaCtx.clearRect(0, 0, w, h);
  for (const f of flames) drawFlame(amaCtx, f, w, h, t);
  drawEmbers(amaCtx, w, h, t);
}

let mx = 0.5, my = 0.5;            // raw pointer, 0..1
let ex = 0.5, ey = 0.5;            // eased pointer
let cursorX = window.innerWidth / 2, cursorY = window.innerHeight / 2;
let cx = cursorX, cy = cursorY;

window.addEventListener('pointermove', e => {
  mx = e.clientX / window.innerWidth;
  my = e.clientY / window.innerHeight;
  cursorX = e.clientX; cursorY = e.clientY;
}, { passive: true });

// touch: let a finger drag the gaze too
window.addEventListener('touchmove', e => {
  const t = e.touches[0];
  if (!t) return;
  mx = t.clientX / window.innerWidth;
  my = t.clientY / window.innerHeight;
}, { passive: true });

/* ═══════════════ ACT III — ghost cursor + reveal + parallax ═══════════════ */
const jutsuSection = document.getElementById('jutsu');
const jutsuReveal = document.getElementById('jutsuReveal');
const ghostCanvas = document.getElementById('ghostCanvas');
const ghost = createGhostCursor(ghostCanvas, {
  color: '#ff2b2b',      // sharingan red
  trailLength: 28,
  brightness: 0.45,      // 29 additive blobs stack fast — higher blows out to white
  edgeIntensity: 0.45,
});

let jutsuLit = false;
let revealX = 0.5, revealY = 0.5;      // eased, section-relative 0..1
let revealTX = 0.5, revealTY = 0.5;
let revealR = 0, revealRT = 500;       // starts dark; opens to 500px spotlight on hover

function setLit(on) {
  if (jutsuLit === on) return;
  jutsuLit = on;
  if (jutsuSection) jutsuSection.classList.toggle('lit', on);
  if (!on && ghost && ghost.leave) ghost.leave();
}

if (jutsuSection) {
  jutsuSection.addEventListener('pointermove', e => {
    if (!jutsuReveal || !jutsuSection) return;
    const revRect = jutsuReveal.getBoundingClientRect();
    const jutRect = jutsuSection.getBoundingClientRect();

    if (revRect.width > 0 && revRect.height > 0) {
      revealTX = clamp((e.clientX - revRect.left) / revRect.width);
      revealTY = clamp((e.clientY - revRect.top) / revRect.height);
    }
    if (jutRect.width > 0 && jutRect.height > 0 && ghost && ghost.move) {
      ghost.move(clamp((e.clientX - jutRect.left) / jutRect.width), clamp((e.clientY - jutRect.top) / jutRect.height), true);
    }
    setLit(true);
  }, { passive: true });

  jutsuSection.addEventListener('pointerleave', () => {
    setLit(false);
  }, { passive: true });
}

/* ── Preview auto-show: visible on scroll-in, dims after 0.5s, re-triggers each visit ── */
const jutsuPreview = document.getElementById('jutsuPreview');
let dimTimer = null;

if (jutsuSection && jutsuPreview) {
  const jutsuObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (jutsuPreview) {
          jutsuPreview.style.transition = 'none';
          if (jutsuSection) jutsuSection.classList.remove('dimmed');
          jutsuPreview.offsetHeight;
          jutsuPreview.style.transition = '';
        }
        clearTimeout(dimTimer);
        dimTimer = setTimeout(() => {
          if (jutsuSection) jutsuSection.classList.add('dimmed');
        }, 500);
      } else {
        clearTimeout(dimTimer);
        if (jutsuPreview) {
          jutsuPreview.style.transition = 'none';
          if (jutsuSection) jutsuSection.classList.remove('dimmed');
          jutsuPreview.offsetHeight;
          jutsuPreview.style.transition = '';
        }
        if (jutsuSection && !jutsuSection.matches(':hover')) {
          setLit(false);
        }
      }
    });
  }, { threshold: 0.15 });

  jutsuObserver.observe(jutsuSection);
}

// hovering a card opens the reveal wider — the image "comes through" the card
document.querySelectorAll('.jutsu .card').forEach(card => {
  card.addEventListener('pointerenter', () => { revealRT = 640; }, { passive: true });
  card.addEventListener('pointerleave', () => { revealRT = 500; }, { passive: true });
});

/* parallax targets: heading bits carry an explicit data-px, cards get one by index */
const pxItems = [...document.querySelectorAll('#jutsu [data-px]')]
  .map(el => ({ el, speed: parseFloat(el.dataset.px) || 0.2, delay: 0 }));

document.querySelectorAll('#jutsu .card').forEach((el, i) => {
  pxItems.push({ el, speed: 0.30 + i * 0.06, delay: i * 0.05 });
});
document.querySelectorAll('.jutsu__amaterasu').forEach(el => {
  pxItems.push({ el, speed: -0.22, delay: 0.1 });
});

// start hidden so nothing pops in before the first parallax paint
pxItems.forEach(it => { it.el.style.opacity = '0'; });
if (ghost && ghost.resize) ghost.resize();

function paintJutsu() {
  if (!jutsuSection) return;
  const r = jutsuSection.getBoundingClientRect();
  const vh = window.innerHeight;
  if (r.top > vh || r.bottom < 0) return;

  // 0 when the section is one viewport below, 1 once its top passes the middle
  const enter = clamp((vh - r.top) / (vh * 0.9));

  for (const it of pxItems) {
    const local = clamp((enter - it.delay) / (1 - it.delay || 1));
    const eased = 1 - Math.pow(1 - local, 3);          // easeOutCubic
    // parallax keeps drifting after the fade completes
    const rect = it.el.getBoundingClientRect();
    const centred = (rect.top + rect.height / 2 - vh / 2) / vh;   // -1..1-ish
    const drift = centred * it.speed * 120;
    it.el.style.opacity = eased.toFixed(3);
    it.el.style.transform =
      `translate3d(0, ${(drift + (1 - eased) * 60).toFixed(1)}px, 0)`;
  }
}

/* ═════════════════════ custom cursor ═════════════════════ */
const cursorEl = document.getElementById('cursor');
if (cursorEl) {
  document.querySelectorAll('a, .card').forEach(el => {
    el.addEventListener('pointerenter', () => cursorEl.classList.add('hot'));
    el.addEventListener('pointerleave', () => cursorEl.classList.remove('hot'));
  });
}

/* ═════════════════════ scroll chrome ═════════════════════ */
const hint = document.getElementById('hint');
const railScroll = document.getElementById('railScroll');
let lastScrollY = window.scrollY;
let scrollDir = 1, scrollVel = 0;

function readScroll() {
  const y = window.scrollY;
  const d = y - lastScrollY;
  if (Math.abs(d) > 0.4) scrollDir = d > 0 ? 1 : -1;
  scrollVel = lerp(scrollVel, Math.min(Math.abs(d) / 42, 1), 0.12);
  lastScrollY = y;

  const doc = document.documentElement.scrollHeight - window.innerHeight;
  const pct = Math.round((y / (doc || 1)) * 100);
  railScroll.textContent = `SCROLL ${String(pct).padStart(3, '0')}%`;
  hint.classList.toggle('hide', y > window.innerHeight * 0.4);
}

/* ═══════════════════════════════════════════════════════════
   STORM — lightning flashes + synthesised thunder
   A strike is a burst of flickers; STRIKE_GAP is the beat between the
   flickers inside one strike. Strikes themselves recur on a random
   interval so it reads as weather rather than a strobe.
   ═══════════════════════════════════════════════════════════ */
const STRIKE_GAP = 250;          // ms between flickers within a strike
const STRIKE_EVERY = [900, 2200];  // ms between strikes (fast, dynamic lightning storm)

const stormFlash = document.getElementById('stormFlash');
const stormBolt = document.getElementById('stormBolt');
const boltPath = document.getElementById('boltPath');
const boltGlow = document.getElementById('boltGlow');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── thunder: filtered noise + sub rumble, no audio files ── */
let audioCtx = null, thunderOn = false;

function initAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function triggerThunderAudio(ctx, power = 1) {
  const now = ctx.currentTime;
  const dur = 2.2 + Math.random() * 2.4 * power;

  // noise burst = the crack
  const frames = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < frames; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;          // brown-ish noise
    d[i] = last * 3.2;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1400 * power, now);
  lp.frequency.exponentialRampToValueAtTime(90, now + dur);   // distance rolloff

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 28;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.55 * power, now + 0.04);  // crack
  gain.gain.exponentialRampToValueAtTime(0.16 * power, now + 0.5);   // body
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);         // rumble tail

  // sub-bass shove you feel more than hear
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(58, now);
  sub.frequency.exponentialRampToValueAtTime(24, now + dur * 0.8);
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.0001, now);
  subGain.gain.exponentialRampToValueAtTime(0.32 * power, now + 0.12);
  subGain.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.85);

  src.connect(hp); hp.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
  sub.connect(subGain); subGain.connect(ctx.destination);

  src.start(now); src.stop(now + dur);
  sub.start(now); sub.stop(now + dur);
}

function playThunder(power = 1) {
  if (!thunderOn) return;
  const ctx = initAudio();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
      triggerThunderAudio(ctx, power);
    }).catch(() => {});
  } else {
    triggerThunderAudio(ctx, power);
  }
}

/* ── bolt geometry: recursive jagged polyline with forks ── */
function makeBolt() {
  const x0 = 80 + Math.random() * 840;
  let x = x0, y = 0;
  let dPath = `M ${x.toFixed(0)} 0`;
  const steps = 14 + Math.floor(Math.random() * 8);
  const forks = [];
  const drift = (Math.random() - 0.5) * 40;

  for (let i = 1; i <= steps; i++) {
    y = (i / steps) * (620 + Math.random() * 300);
    x += drift + (Math.random() - 0.5) * 130;
    x = Math.max(20, Math.min(980, x));
    dPath += ` L ${x.toFixed(0)} ${y.toFixed(0)}`;
    if (Math.random() < 0.30 && i > 3) {
      let fx = x, fy = y, f = `M ${x.toFixed(0)} ${y.toFixed(0)}`;
      const fs = 2 + Math.floor(Math.random() * 4);
      for (let k = 0; k < fs; k++) {
        fx += (Math.random() - 0.5) * 150;
        fy += 40 + Math.random() * 80;
        f += ` L ${fx.toFixed(0)} ${fy.toFixed(0)}`;
      }
      forks.push(f);
    }
  }
  return { d: dPath + ' ' + forks.join(' '), x: x0 / 1000 };
}

let stormTimer = null;

function flicker(el, peak, ms) {
  el.style.transition = 'none';
  el.style.opacity = String(peak);
  requestAnimationFrame(() => {
    el.style.transition = `opacity ${ms}ms cubic-bezier(.22,1,.36,1)`;
    el.style.opacity = '0';
  });
}

/* ── Quiet Mode: Only active on dedicated Application portal page (application.html) ── */
function isInQuietZone() {
  return document.body.classList.contains('app-page');
}

function strike() {
  if (isInQuietZone()) {
    const [lo, hi] = STRIKE_EVERY;
    stormTimer = setTimeout(strike, lo + Math.random() * (hi - lo));
    return;
  }
  const heavy = Math.random() < 0.55;           // heavy = visible bolt
  const power = heavy ? 1 : 0.55 + Math.random() * 0.25;

  if (heavy) {
    const b = makeBolt();
    boltPath.setAttribute('d', b.d);
    boltGlow.setAttribute('d', b.d);
    stormFlash.style.setProperty('--bx', (b.x * 100).toFixed(0) + '%');
    flicker(stormBolt, 1, 190);
  } else {
    stormFlash.style.setProperty('--bx', (15 + Math.random() * 70).toFixed(0) + '%');
  }

  flicker(stormFlash, heavy ? 0.9 : 0.42, heavy ? 380 : 300);

  // the second beat of the same strike, one STRIKE_GAP later
  const beats = heavy ? 1 + Math.floor(Math.random() * 2) : 1;
  for (let i = 1; i <= beats; i++) {
    setTimeout(() => {
      flicker(stormFlash, (heavy ? 0.7 : 0.3) * (1 - i * 0.2), 260);
      if (heavy && i === 1) flicker(stormBolt, 0.75, 140);
    }, STRIKE_GAP * i);
  }

  // thunder trails the flash by the speed of sound
  setTimeout(() => playThunder(power), heavy ? 260 : 620);

  const [lo, hi] = STRIKE_EVERY;
  stormTimer = setTimeout(strike, lo + Math.random() * (hi - lo));
}

if (!reducedMotion) stormTimer = setTimeout(strike, 500);

/* ── Thunder Audio Management (Web Audio Synthesizer) ── */
function unlockAudioContext() {
  if (!thunderOn) return;
  const ctx = initAudio();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

// Automatically unlock Web Audio Context on any user interaction, scroll, or mouse movement
['pointerdown', 'mousedown', 'touchstart', 'scroll', 'wheel', 'keydown', 'mousemove'].forEach(evt => {
  window.addEventListener(evt, unlockAudioContext, { passive: true });
});

// Web Audio Context will unlock on first user gesture or sound toggle click

const soundToggle = document.getElementById('soundToggle');
if (soundToggle) {
  soundToggle.setAttribute('aria-pressed', String(thunderOn));
  soundToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    thunderOn = !thunderOn;
    soundToggle.setAttribute('aria-pressed', String(thunderOn));
    if (thunderOn) {
      unlockAudioContext();
    }
  });
}

/* ═════════════════════ resize ═════════════════════ */
function resizeAll() {
  mainCtx = fitCanvas(mainCanvas);
  fCtx = fitCanvas(featherCanvas);
  amaCtx = fitCanvas(amaCanvas);
  lastDrawn = -1;
  seedFeathers();
  seedFlames(); amaPainted = false;
  ghost.resize();
}
let rt;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resizeAll, 140); });

/* ═════════════════════ main loop ═════════════════════ */
function tick() {
  readScroll();
  readScrub();

  if (syncSize(mainCanvas) ||
    syncSize(featherCanvas) || syncSize(amaCanvas)) resizeAll();

  /* — Amaterasu: black flame hem — */
  const inQuiet = isInQuietZone();
  const stormEl = document.querySelector('.storm');
  const amaBed = document.querySelector('.amaterasu-bed');
  if (stormEl) stormEl.style.opacity = inQuiet ? '0' : '1';
  if (amaCanvas) amaCanvas.style.opacity = inQuiet ? '0' : '1';
  if (amaBed) amaBed.style.opacity = inQuiet ? '0' : '1';

  if (!reduceMotion) paintAmaterasu(performance.now() / 1000);
  else if (!amaPainted) { paintAmaterasu(0); amaPainted = true; }

  const fadeInCanvas = clamp((scrubProgress - 0.03) / 0.05);
  const fadeOutCanvas = 1 - clamp((scrubProgress - 0.87) / 0.08);
  const canvasAlpha = fadeInCanvas * fadeOutCanvas;
  if (mainCanvas) mainCanvas.style.opacity = canvasAlpha.toFixed(3);

  // Show sticky blur lens ONLY while scrubbing through mainFrames in Act I
  const stickyBadge = document.getElementById('stickyBadge');
  if (stickyBadge) {
    const isAct1Scrubbing = scrubProgress > 0.02 && scrubProgress < 0.96;
    stickyBadge.style.opacity = isAct1Scrubbing ? '1' : '0';
  }

  frameShown = lerp(frameShown, frameTarget, 0.14);
  const idx = Math.round(clamp(frameShown, 0, MAIN_COUNT - 1));
  if (idx !== lastDrawn) {
    const w = mainCanvas.width, h = mainCanvas.height;
    mainCtx.clearRect(0, 0, w, h);
    if (drawCover(mainCtx, mainFrames[idx], w, h)) lastDrawn = idx;
  }
  paintOverlays(scrubProgress);

  /* — feathers: disabled per user request — */
  const fw = featherCanvas.width, fh = featherCanvas.height;
  fCtx.clearRect(0, 0, fw, fh);

  /* — Act III: parallax, reveal mask, ghost cursor — */
  paintJutsu();

  const jr = jutsuSection.getBoundingClientRect();
  if (jr.top < window.innerHeight && jr.bottom > 0) {
    revealX = lerp(revealX, revealTX, 0.18);
    revealY = lerp(revealY, revealTY, 0.18);
    revealR = lerp(revealR, jutsuLit ? revealRT : 0, 0.12);

    const rxStr = (revealX * 100).toFixed(2) + '%';
    const ryStr = (revealY * 100).toFixed(2) + '%';
    const rStr = revealR.toFixed(0) + 'px';

    if (jutsuReveal) {
      jutsuReveal.style.setProperty('--rx', rxStr);
      jutsuReveal.style.setProperty('--ry', ryStr);
      jutsuReveal.style.setProperty('--r', rStr);
    }
    const rs = jutsuSection.style;
    rs.setProperty('--rx', rxStr);
    rs.setProperty('--ry', ryStr);
    rs.setProperty('--r', rStr);

    if (ghost.ok && (jutsuLit || revealR > 1)) ghost.render();
  }

  /* — cursor — */
  cx = lerp(cx, cursorX, 0.2);
  cy = lerp(cy, cursorY, 0.2);
  cursorEl.style.transform = `translate(${cx}px, ${cy}px)`;

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ═════════════════════ reveals ═════════════════════ */
/* #jutsu is excluded — it runs the scroll-driven parallax instead */
document.querySelectorAll(
  '.quote__jp, .quote blockquote, .quote__mark, .footer__big, .footer__row'
).forEach((el, i) => {
  el.setAttribute('data-reveal', '');
  if (!el.style.getPropertyValue('--i')) el.style.setProperty('--i', i % 4);
});

const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.18 });
document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));

/* ═════════════════════ GALLERY AUTO-SLIDER (5s interval) ═════════════════════ */
(function initGallerySlider() {
  const slides = document.querySelectorAll('.gallery__slide');
  const dots = document.querySelectorAll('.gallery__dots .dot');
  const prevBtn = document.getElementById('galleryPrev');
  const nextBtn = document.getElementById('galleryNext');
  const sliderEl = document.getElementById('gallerySlider');
  if (!slides.length) return;

  let currentIndex = 0;
  let timer = null;

  function showSlide(index) {
    currentIndex = (index + slides.length) % slides.length;
    slides.forEach((s, i) => s.classList.toggle('active', i === currentIndex));
    dots.forEach((d, i) => d.classList.toggle('active', i === currentIndex));
  }

  function nextSlide() {
    showSlide(currentIndex + 1);
  }

  function prevSlide() {
    showSlide(currentIndex - 1);
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(nextSlide, 5000); // 5 seconds interval
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
  }

  if (nextBtn) nextBtn.addEventListener('click', () => { nextSlide(); startTimer(); });
  if (prevBtn) prevBtn.addEventListener('click', () => { prevSlide(); startTimer(); });

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const idx = parseInt(dot.getAttribute('data-index'), 10);
      if (!isNaN(idx)) { showSlide(idx); startTimer(); }
    });
  });

  if (sliderEl) {
    sliderEl.addEventListener('mouseenter', stopTimer);
    sliderEl.addEventListener('mouseleave', startTimer);
  }

  startTimer();
})();

/* ═════════════════════ FORM HANDLERS ═════════════════════ */
// PASTE YOUR DEPLOYED GOOGLE APPS SCRIPT WEB APP URL BELOW:
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwKxGJ5p0WmzVjIV5qXV9JPie0uzYiHOvUuKPXeJt-3hGF52c70tkfi239TU1NKmTvWEg/exec';

/* ── Anti-spam protection & Unique Email Enforcement ── */
let _lastSubmitTime = 0;
const _submittedEmails = new Set();
const SUBMIT_COOLDOWN_MS = 60000; // 60 seconds between submissions

function getSubmittedEmails() {
  try {
    const stored = JSON.parse(localStorage.getItem('vividhata_submitted_emails') || '[]');
    const set = new Set(stored.map(e => String(e).toLowerCase().trim()));
    _submittedEmails.forEach(e => set.add(e));
    return set;
  } catch (e) {
    return _submittedEmails;
  }
}

function recordSubmittedEmail(email) {
  if (!email) return;
  const cleanEmail = String(email).toLowerCase().trim();
  _submittedEmails.add(cleanEmail);
  try {
    const stored = JSON.parse(localStorage.getItem('vividhata_submitted_emails') || '[]');
    if (!stored.includes(cleanEmail)) {
      stored.push(cleanEmail);
      localStorage.setItem('vividhata_submitted_emails', JSON.stringify(stored));
    }
  } catch (e) {}
}

function isEmailAlreadySubmitted(email) {
  if (!email) return false;
  const cleanEmail = String(email).toLowerCase().trim();
  const set = getSubmittedEmails();
  return set.has(cleanEmail);
}

window.formSubmitted = false;

function showFormSuccess(candidateName, teamName) {
  const form = document.getElementById('regForm');
  const modal = document.getElementById('regSuccessModal');
  const nameEl = document.getElementById('successCandidateName');
  const teamEl = document.getElementById('successTeamName');

  if (nameEl && candidateName) nameEl.textContent = candidateName;
  if (teamEl && teamName) teamEl.textContent = teamName;

  if (modal) {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }

  const successCard = document.getElementById('regSuccess');
  if (form) form.style.display = 'none';
  if (successCard) {
    successCard.style.display = 'block';
    successCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function closeSuccessModal() {
  const modal = document.getElementById('regSuccessModal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
}

function resetRegFormModal() {
  closeSuccessModal();
  resetRegForm();
}

function resetRegForm() {
  closeSuccessModal();
  const form = document.getElementById('regForm');
  const successCard = document.getElementById('regSuccess');
  if (form) {
    form.reset();
    form.style.display = 'flex';
  }
  if (successCard) successCard.style.display = 'none';
  window.formSubmitted = false;
  const photoLabel = document.getElementById('photoLabel');
  const resumeLabel = document.getElementById('resumeLabel');
  if (photoLabel) photoLabel.textContent = '📁 Choose Photo...';
  if (resumeLabel) resumeLabel.textContent = '📁 Choose Resume PDF...';
  const photoPreviewCard = document.getElementById('photoPreviewCard');
  const resumePreviewCard = document.getElementById('resumePreviewCard');
  if (photoPreviewCard) photoPreviewCard.style.display = 'none';
  if (resumePreviewCard) resumePreviewCard.style.display = 'none';
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
    reader.readAsDataURL(file);
  });
}

function initFormHandlers() {
  const photoFile = document.getElementById('photoFile');
  const photoLabel = document.getElementById('photoLabel');
  const photoPreviewCard = document.getElementById('photoPreviewCard');
  const photoPreviewImg = document.getElementById('photoPreviewImg');
  const photoFileName = document.getElementById('photoFileName');

  if (photoFile && photoLabel) {
    photoFile.addEventListener('change', () => {
      if (photoFile.files.length > 0) {
        const file = photoFile.files[0];
        photoLabel.textContent = '✓ ' + file.name;
        if (photoPreviewImg && photoFileName && photoPreviewCard) {
          photoPreviewImg.src = URL.createObjectURL(file);
          photoFileName.textContent = file.name;
          photoPreviewCard.style.display = 'flex';
        }
      } else {
        photoLabel.textContent = '📁 Choose Photo...';
        if (photoPreviewCard) photoPreviewCard.style.display = 'none';
      }
    });
  }

  const resumeFile = document.getElementById('resumeFile');
  const resumeLabel = document.getElementById('resumeLabel');
  const resumePreviewCard = document.getElementById('resumePreviewCard');
  const resumeFileName = document.getElementById('resumeFileName');

  if (resumeFile && resumeLabel) {
    resumeFile.addEventListener('change', () => {
      if (resumeFile.files.length > 0) {
        const file = resumeFile.files[0];
        resumeLabel.textContent = '✓ ' + file.name;
        if (resumeFileName && resumePreviewCard) {
          resumeFileName.textContent = file.name;
          resumePreviewCard.style.display = 'flex';
        }
      } else {
        resumeLabel.textContent = '📁 Choose Resume PDF...';
        if (resumePreviewCard) resumePreviewCard.style.display = 'none';
      }
    });
  }

  const regForm = document.getElementById('regForm');
  if (regForm) {
    /* ── Prevent duplicate team preferences ── */
    const prefTeamSel = document.getElementById('prefTeam');
    const secondTeamSel = document.getElementById('secondTeam');

    function syncTeamDropdowns() {
      if (!prefTeamSel || !secondTeamSel) return;
      const prefVal = prefTeamSel.value;
      const secVal = secondTeamSel.value;

      // Re-enable all options in both selects first
      Array.from(secondTeamSel.options).forEach(opt => { opt.disabled = false; });
      Array.from(prefTeamSel.options).forEach(opt => { opt.disabled = false; });

      // Disable the selected pref team in second dropdown (skip "None"/empty)
      if (prefVal && prefVal !== 'None') {
        Array.from(secondTeamSel.options).forEach(opt => {
          if (opt.value === prefVal) opt.disabled = true;
        });
        // If second was same as pref, reset it
        if (secVal === prefVal) secondTeamSel.value = 'None';
      }

      // Disable the selected second team in pref dropdown (skip "None"/empty)
      if (secVal && secVal !== 'None') {
        Array.from(prefTeamSel.options).forEach(opt => {
          if (opt.value === secVal) opt.disabled = true;
        });
      }
    }

    if (prefTeamSel) prefTeamSel.addEventListener('change', syncTeamDropdowns);
    if (secondTeamSel) secondTeamSel.addEventListener('change', syncTeamDropdowns);

    /* ── Real-time Email Duplicate Guard ── */
    const emailInput = document.getElementById('email');
    const emailErrNotice = document.getElementById('emailDuplicateNotice');
    if (emailInput) {
      function checkEmailDuplicate() {
        const val = (emailInput.value || '').toLowerCase().trim();
        if (val && isEmailAlreadySubmitted(val)) {
          emailInput.style.borderColor = '#ff3e3e';
          if (emailErrNotice) {
            emailErrNotice.style.display = 'block';
            emailErrNotice.textContent = '⚠️ An application has already been submitted for ' + val + '. Duplicate entries are not allowed.';
          }
        } else {
          emailInput.style.borderColor = '';
          if (emailErrNotice) {
            emailErrNotice.style.display = 'none';
          }
        }
      }
      emailInput.addEventListener('blur', checkEmailDuplicate);
      emailInput.addEventListener('input', checkEmailDuplicate);
    }

    regForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleRegFormSubmit(e);
    });
  }
}

window.handleRegFormSubmit = async function(e) {
  if (e) {
    e.preventDefault();
  }

  const regForm = document.getElementById('regForm');
  if (!regForm) return;

  // Trigger HTML5 validation check
  if (!regForm.checkValidity()) {
    regForm.reportValidity();
    return;
  }

  // Final duplicate team guard
  const p = document.getElementById('prefTeam')?.value || '';
  const s = document.getElementById('secondTeam')?.value || '';
  if (p && s && s !== 'None' && p === s) {
    alert('Preferred Team and Second Preference cannot be the same.');
    return;
  }

  // Unique Email Guard (Strictly 1 application per email address)
  const candidateEmail = (document.getElementById('email')?.value || '').toLowerCase().trim();
  if (candidateEmail && isEmailAlreadySubmitted(candidateEmail)) {
    alert('⚠️ Duplicate Submission Error:\nAn application has already been submitted for ' + candidateEmail + '.\nOnly 1 application per email address is allowed.');
    const emailEl = document.getElementById('email');
    if (emailEl) {
      emailEl.focus();
      emailEl.style.borderColor = '#ff3e3e';
    }
    return;
  }

  // ── Anti-spam checks ──
  const honeypot = document.getElementById('hp_anti_bot_trap_vividhata');
  if (honeypot && honeypot.value && honeypot.value.trim().length > 0) {
    console.warn('Spam submission blocked by honeypot.');
    return;
  }

  // Cooldown check (2 sec cooldown)
  const now = Date.now();
  if (now - _lastSubmitTime < 2000) {
    alert('Please wait a moment before submitting again.');
    return;
  }

  const submitBtn = document.getElementById('regSubmitBtn');
  const origBtnHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    const spanEl = submitBtn.querySelector('span');
    if (spanEl) spanEl.textContent = 'SUBMITTING APPLICATION...';
  }

  try {
    const skillsChecked = Array.from(document.querySelectorAll('.skill-pill input[type="checkbox"]:checked'))
      .map(cb => cb.value)
      .join(', ');

    const yearChecked = document.querySelector('input[name="entry.1000006"]:checked');
    const prevClubChecked = document.querySelector('input[name="entry.1000010"]:checked');

    const payload = {
      timestamp: new Date().toISOString(),
      fullName: (document.getElementById('fullName')?.value || '').trim(),
      email: (document.getElementById('email')?.value || '').trim(),
      prefTeam: document.getElementById('prefTeam')?.value || '',
      secondTeam: document.getElementById('secondTeam')?.value || '',
      mobile: (document.getElementById('mobile')?.value || '').replace(/^[+=\-@]+/, '').trim(),
      rollNo: (document.getElementById('rollNo')?.value || '').trim(),
      branch: (document.getElementById('branch')?.value || '').trim(),
      year: yearChecked ? yearChecked.value : '',
      section: (document.getElementById('section')?.value || '').trim(),
      hasPrevClub: prevClubChecked ? prevClubChecked.value : '',
      prevClubRole: (document.getElementById('prevClubRole')?.value || '').trim(),
      skills: skillsChecked
    };

    // 1. Save local copy
    try {
      const existing = JSON.parse(localStorage.getItem('vividhata_submissions') || '[]');
      existing.push(payload);
      localStorage.setItem('vividhata_submissions', JSON.stringify(existing));
    } catch (err) { }

    // 2. Post to Google Apps Script Web App (single fetch - no duplicate transmissions)
    if (GOOGLE_SCRIPT_URL && GOOGLE_SCRIPT_URL.startsWith('http')) {
      const jsonBody = JSON.stringify(payload);
      try {
        await fetch(GOOGLE_SCRIPT_URL, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: jsonBody
        });
      } catch (netErr) {
        console.warn('Network submission attempt completed:', netErr);
      }
    }

    window.formSubmitted = true;
    _lastSubmitTime = Date.now();
    if (payload.email) recordSubmittedEmail(payload.email);

    const candidateFullName = payload.fullName || 'Applicant';
    const candidatePrefTeam = payload.prefTeam || 'Vividhata Club 2026';

    // Show both the modal overlay popup and the success card
    showFormSuccess(candidateFullName, candidatePrefTeam);
  } catch (error) {
    console.error('Submission error:', error);
    alert('Form submission error: ' + error.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origBtnHtml;
    }
  }
};

function initPhoneNavDock() {
  const phoneNavItems = document.querySelectorAll('.phone-nav-item');
  phoneNavItems.forEach(item => {
    item.addEventListener('click', (e) => {
      phoneNavItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
    });
  });
}

function initMobileNav() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const chromeNav = document.getElementById('chromeNav');

  if (hamburgerBtn && chromeNav) {
    hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = chromeNav.classList.toggle('open');
      hamburgerBtn.classList.toggle('open');
      hamburgerBtn.setAttribute('aria-expanded', String(isOpen));
    });

    const navLinks = chromeNav.querySelectorAll('a');
    navLinks.forEach(link => {
      link.addEventListener('click', () => {
        chromeNav.classList.remove('open');
        hamburgerBtn.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('click', (e) => {
      if (chromeNav.classList.contains('open') && !chromeNav.contains(e.target) && !hamburgerBtn.contains(e.target)) {
        chromeNav.classList.remove('open');
        hamburgerBtn.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

/* ══════════ NOTIFICATION SIDEBAR DRAWER TOGGLE ══════════ */
function initNotificationSidebar() {
  const phoneBellBtn = document.getElementById('phoneBellBtn');
  const notifySidebar = document.getElementById('notifySidebar');
  const notifyOverlay = document.getElementById('notifyOverlay');
  const notifyCloseBtn = document.getElementById('notifyCloseBtn');

  function openNotifications(e) {
    if (e) e.stopPropagation();
    if (notifySidebar) notifySidebar.classList.add('active');
    if (notifyOverlay) notifyOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeNotifications(e) {
    if (e) e.stopPropagation();
    if (notifySidebar) notifySidebar.classList.remove('active');
    if (notifyOverlay) notifyOverlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (phoneBellBtn) phoneBellBtn.addEventListener('click', openNotifications);
  if (notifyCloseBtn) notifyCloseBtn.addEventListener('click', closeNotifications);
  if (notifyOverlay) notifyOverlay.addEventListener('click', closeNotifications);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && notifySidebar && notifySidebar.classList.contains('active')) {
      closeNotifications();
    }
  });
}

/* ══════════ TOP MOBILE NAV DRAWER TOGGLE ══════════ */
function initPhoneNavDrawer() {
  const phoneMenuBtn = document.getElementById('phoneMenuBtn');
  const phoneNavDrawer = document.getElementById('phoneNavDrawer');
  const phoneNavOverlay = document.getElementById('phoneNavOverlay');
  const phoneNavCloseBtn = document.getElementById('phoneNavCloseBtn');

  function openPhoneNav(e) {
    if (e) e.stopPropagation();
    if (phoneNavDrawer) phoneNavDrawer.classList.add('active');
    if (phoneNavOverlay) phoneNavOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closePhoneNav(e) {
    if (e) e.stopPropagation();
    if (phoneNavDrawer) phoneNavDrawer.classList.remove('active');
    if (phoneNavOverlay) phoneNavOverlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (phoneMenuBtn) phoneMenuBtn.addEventListener('click', openPhoneNav);
  if (phoneNavCloseBtn) phoneNavCloseBtn.addEventListener('click', closePhoneNav);
  if (phoneNavOverlay) phoneNavOverlay.addEventListener('click', closePhoneNav);

  const drawerLinks = document.querySelectorAll('.phone-drawer-link');
  drawerLinks.forEach(link => {
    link.addEventListener('click', () => {
      closePhoneNav();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && phoneNavDrawer && phoneNavDrawer.classList.contains('active')) {
      closePhoneNav();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initFormHandlers();
    initMobileNav();
    initPhoneNavDock();
    initNotificationSidebar();
    initPhoneNavDrawer();
  });
} else {
  initFormHandlers();
  initMobileNav();
  initPhoneNavDock();
  initNotificationSidebar();
  initPhoneNavDrawer();
}

