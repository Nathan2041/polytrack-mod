// ==UserScript==
// @name         PolyTrack Controller
// @description  Gamepad / Switch Pro Controller support for PolyTrack
// @match        https://app-polytrack.kodub.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function PolyTrackController() {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  CONFIG                                                              */
  /* ------------------------------------------------------------------ */
  const CFG = {
    steerStick    : 'left',   // 'left' = axis 0, 'right' = axis 2

    accelBtn      : 7,
    brakeBtn      : 6,
    handbrakeBtn  : 4,
    respawnBtn    : 5,
    checkpointBtn : 1,
    triggerMin    : 0.05,

    // How often the sigma-delta updates steering (ms).
    // Higher = longer key hold/release windows = game steering has time to
    // build and decay between pulses = more noticeable difference between
    // duty cycles. Try 20-80ms.
    modulationMs  : 40,

    // Power curve applied to stick input before sigma-delta.
    // 1.0 = linear. Higher = more stick travel needed for high duty cycles.
    steerCurve    : 3.0,

    // Minimum duty cycle for any non-zero stick input (0..1).
    minSteerDuty  : 0.05,

    keys: {
      left       : { key: 'ArrowLeft',  code: 'ArrowLeft'  },
      right      : { key: 'ArrowRight', code: 'ArrowRight' },
      accel      : { key: 'ArrowUp',    code: 'ArrowUp'    },
      brake      : { key: 'ArrowDown',  code: 'ArrowDown'  },
      handbrake  : { key: ' ',          code: 'Space'      },
      respawn    : { key: 'r',          code: 'KeyR'       },
      checkpoint : { key: 'q',          code: 'KeyQ'       },
    },
  };

  /* ------------------------------------------------------------------ */
  /*  Key injection                                                       */
  /* ------------------------------------------------------------------ */
  const heldKeys = new Set();

  function pressKey(id, active) {
    const k = CFG.keys[id];
    if (!k) return;
    const isHeld = heldKeys.has(id);
    if (active === isHeld) return;
    if (active) heldKeys.add(id); else heldKeys.delete(id);
    const type = active ? 'keydown' : 'keyup';
    const opts = { key: k.key, code: k.code, bubbles: true, cancelable: true };
    for (const el of [document, window, document.body, document.querySelector('canvas'), document.activeElement]) {
      try { el?.dispatchEvent(new KeyboardEvent(type, opts)); } catch (_) {}
    }
  }

  function releaseAll() {
    for (const id of [...heldKeys]) pressKey(id, false);
  }

  /* ------------------------------------------------------------------ */
  /*  Sigma-delta steering - only fires every CFG.modulationMs           */
  /* ------------------------------------------------------------------ */
  let steerError  = 0;
  let lastModTime = 0;

  function updateSteering(rawSteer, now) {
    if (now - lastModTime < CFG.modulationMs) return;
    lastModTime = now;

    if (rawSteer === 0) {
      steerError = 0;
      pressKey('left',  false);
      pressKey('right', false);
      return;
    }

    const curved = Math.pow(Math.abs(rawSteer), CFG.steerCurve);
    const steer  = (CFG.minSteerDuty + (1 - CFG.minSteerDuty) * curved) * Math.sign(rawSteer);

    steerError += steer;
    steerError  = Math.max(-1.5, Math.min(1.5, steerError));

    if (steerError > 0.5) {
      pressKey('right', true);  pressKey('left',  false); steerError -= 1;
    } else if (steerError < -0.5) {
      pressKey('left',  true);  pressKey('right', false); steerError += 1;
    } else {
      pressKey('left',  false); pressKey('right', false);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Main tick                                                           */
  /* ------------------------------------------------------------------ */
  function tick() {
    const gpads = navigator.getGamepads();
    let gp = null;
    for (const g of gpads) { if (g?.connected) { gp = g; break; } }
    if (!gp) { releaseAll(); return; }

    const steerAxis = CFG.steerStick === 'right' ? 2 : 0;
    updateSteering(gp.axes[steerAxis] ?? 0, performance.now());

    pressKey('accel',      (gp.buttons[CFG.accelBtn]?.value     ?? 0) > CFG.triggerMin);
    pressKey('brake',      (gp.buttons[CFG.brakeBtn]?.value     ?? 0) > CFG.triggerMin);
    pressKey('handbrake',   gp.buttons[CFG.handbrakeBtn]?.pressed ?? false);
    pressKey('respawn',     gp.buttons[CFG.respawnBtn]?.pressed   ?? false);
    pressKey('checkpoint',  gp.buttons[CFG.checkpointBtn]?.pressed ?? false);
  }

  /* ------------------------------------------------------------------ */
  /*  Game loop hook                                                      */
  /* ------------------------------------------------------------------ */
  let hooked = false;
  const _setInterval = window.setInterval;
  const _rAF         = window.requestAnimationFrame;

  function installHook(label) {
    if (hooked) return;
    hooked = true;
    console.log('[Controller] Hooked game loop (' + label + ').');
    if (typeof label === 'number') {
      _setInterval(tick, label);
    } else {
      (function rafTick() { tick(); _rAF(rafTick); })();
    }
  }

  window.setInterval = function (fn, delay) {
    const args = Array.prototype.slice.call(arguments);
    const id = _setInterval.apply(this, args);
    if (!hooked && typeof delay === 'number' && delay <= 2) installHook(delay);
    return id;
  };

  window.requestAnimationFrame = function (fn) {
    const id = _rAF.call(this, fn);
    if (!hooked) installHook('rAF');
    return id;
  };

  setTimeout(function() {
    if (!hooked) { console.log('[Controller] Fallback 4ms interval.'); _setInterval(tick, 4); }
  }, 3000);

  /* ------------------------------------------------------------------ */
  /*  Gamepad detection                                                   */
  /* ------------------------------------------------------------------ */
  window.addEventListener('gamepadconnected', function(e) {
    console.log('[Controller] Connected: ' + e.gamepad.id);
    steerError = 0;
  });
  window.addEventListener('gamepaddisconnected', function() {
    console.log('[Controller] Disconnected');
    releaseAll();
  });

  var _poll = _setInterval(function() {
    var gpads = navigator.getGamepads();
    for (var i = 0; i < gpads.length; i++) {
      if (gpads[i] && gpads[i].connected) {
        console.log('[Controller] Found: ' + gpads[i].id);
        steerError = 0;
        clearInterval(_poll);
        break;
      }
    }
  }, 500);

  /* ------------------------------------------------------------------ */
  /*  Floating UI panel                                                   */
  /* ------------------------------------------------------------------ */
  function buildUI() {
    // Shadow host — fixed position shell that the page CSS cannot reach inside
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;';
    var shadow = host.attachShadow({ mode: 'open' });

    // Reset stylesheet so the game's global CSS has zero effect inside
    var resetStyle = document.createElement('style');
    resetStyle.textContent = [
      ':host { all: initial; }',
      '* { box-sizing: border-box; font-family: monospace; }',
      'input[type=range] {',
      '  all: revert;',
      '  width: 110px;',
      '  accent-color: #6cf;',
      '  cursor: pointer;',
      '  margin: 0;',
      '}',
      'select {',
      '  all: revert;',
      '  background: #1e1e2e;',
      '  color: #e8e8e8;',
      '  border: 1px solid #555;',
      '  border-radius: 4px;',
      '  padding: 2px 6px;',
      '  cursor: pointer;',
      '}',
    ].join('\n');
    shadow.appendChild(resetStyle);

    var panel = document.createElement('div');
    panel.style.cssText = [
      'background:rgba(12,12,18,0.93)', 'color:#e8e8e8',
      'font:13px/1.6 monospace', 'border:1px solid #3a3a4a',
      'border-radius:10px', 'padding:12px 16px', 'min-width:260px',
      'box-shadow:0 4px 24px rgba(0,0,0,0.7)', 'user-select:none',
    ].join(';');

    // Drag — moves the host element
    var dragging = false, ox = 0, oy = 0;
    panel.addEventListener('mousedown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      dragging = true;
      var r = host.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      host.style.left  = (e.clientX - ox) + 'px';
      host.style.top   = (e.clientY - oy) + 'px';
      host.style.right = 'auto';
    });
    document.addEventListener('mouseup', function() { dragging = false; });

    function makeRow(labelText, control) {
      var d = document.createElement('div');
      d.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:6px 0;gap:8px;';
      var l = document.createElement('span');
      l.textContent = labelText;
      l.style.cssText = 'color:#999;white-space:nowrap;min-width:90px;';
      d.appendChild(l);
      d.appendChild(control);
      return d;
    }

    function makeSlider(key, min, max, step) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

      var s = document.createElement('input');
      s.type = 'range'; s.min = min; s.max = max; s.step = step;
      s.value = CFG[key];

      var v = document.createElement('span');
      v.style.cssText = 'min-width:36px;text-align:right;color:#6cf;';
      v.textContent = CFG[key];

      s.addEventListener('input', function() {
        CFG[key] = parseFloat(s.value);
        v.textContent = s.value;
        steerError = 0;
      });

      wrap.appendChild(s);
      wrap.appendChild(v);
      return wrap;
    }

    function makeSelect(key, options) {
      var s = document.createElement('select');
      s.style.cssText = 'cursor:pointer;';
      options.forEach(function(pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        if (CFG[key] === pair[0]) o.selected = true;
        s.appendChild(o);
      });
      s.addEventListener('change', function() { CFG[key] = s.value; steerError = 0; });
      return s;
    }

    // Title
    var title = document.createElement('div');
    title.textContent = 'PolyTrack Controller';
    title.style.cssText = 'font-weight:bold;font-size:14px;color:#fff;margin-bottom:4px;cursor:move;';

    // Status
    var status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:#666;border-bottom:1px solid #2a2a3a;padding-bottom:8px;margin-bottom:8px;';
    status.textContent = 'No controller - press a button';
    _setInterval(function() {
      var gpads = navigator.getGamepads();
      var found = false;
      for (var i = 0; i < gpads.length; i++) {
        if (gpads[i] && gpads[i].connected) {
          status.textContent = '🎮 ' + gpads[i].id.slice(0, 30);
          found = true; break;
        }
      }
      if (!found) status.textContent = 'No controller - press a button';
    }, 800);

    // Minimize button
    var mini = document.createElement('span');
    mini.textContent = '−';
    mini.style.cssText = 'float:right;cursor:pointer;color:#888;font-size:16px;line-height:1;margin-top:-2px;';
    var minimized = false;
    var body = document.createElement('div');
    mini.addEventListener('click', function() {
      minimized = !minimized;
      body.style.display = minimized ? 'none' : '';
      mini.textContent = minimized ? '+' : '−';
    });

    body.appendChild(status);
    body.appendChild(makeRow('Stick',         makeSelect('steerStick', [['left','Left (axis 0)'],['right','Right (axis 2)']])));
    body.appendChild(makeRow('Curve',         makeSlider('steerCurve',   1, 8,   0.1)));
    body.appendChild(makeRow('Min duty',      makeSlider('minSteerDuty', 0, 0.5, 0.01)));
    body.appendChild(makeRow('Modulation ms', makeSlider('modulationMs', 1, 120, 1)));

    var hint = document.createElement('div');
    hint.textContent = 'Drag title to move';
    hint.style.cssText = 'font-size:10px;color:#444;margin-top:8px;border-top:1px solid #2a2a3a;padding-top:6px;';
    body.appendChild(hint);

    title.appendChild(mini);
    panel.appendChild(title);
    panel.appendChild(body);
    shadow.appendChild(panel);
    document.body.appendChild(host);
  }

  if (document.body) buildUI();
  else document.addEventListener('DOMContentLoaded', buildUI);

  window.PolyTrackController = { CFG, releaseAll };
  console.log('[Controller] PolyTrack gamepad support active.');
})();