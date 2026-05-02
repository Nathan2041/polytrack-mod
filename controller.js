(function PolyTrackController() {
  'use strict';

  const CFG = {
    steerStick    : 'left',  // 'left' = axis 0, 'right' = axis 2
    accelBtn      : 7,   // W
    brakeBtn      : 6,   // S
    respawnBtn    : 5,   // R
    cBtn          : 4,   // C
    triggerMin    : 0.05,
    steerCurve    : 1.0,
    minSteerDuty  : 0.0,
    keys: {
      left       : { key: 'ArrowLeft',  code: 'ArrowLeft'  },
      right      : { key: 'ArrowRight', code: 'ArrowRight' },
      accel      : { key: 'ArrowUp',    code: 'ArrowUp'    },
      brake      : { key: 'ArrowDown',  code: 'ArrowDown'  },
      respawn    : { key: 'r',          code: 'KeyR'       },
      c          : { key: 'c',          code: 'KeyC'       },
    },
  };

  /* Key injection */
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

  /* Sigma-delta steering */
  let steerError = 0;

  function updateSteering(rawSteer) {
    if (rawSteer === 0) {
      steerError = 0;
      pressKey('left',  false);
      pressKey('right', false);
      return;
    }
    const curved = Math.pow(Math.abs(rawSteer), CFG.steerCurve);
    const steer  = (CFG.minSteerDuty + (1 - CFG.minSteerDuty) * curved) * Math.sign(rawSteer);
    steerError  += steer;
    steerError   = Math.max(-1.5, Math.min(1.5, steerError));
    if (steerError > 0.5) {
      pressKey('right', true);  pressKey('left',  false); steerError -= 1;
    } else if (steerError < -0.5) {
      pressKey('left',  true);  pressKey('right', false); steerError += 1;
    } else {
      pressKey('left',  false); pressKey('right', false);
    }
  }

  /* Main tick */
  function tick() {
    const gpads = navigator.getGamepads();
    let gp = null;
    for (const g of gpads) { if (g?.connected) { gp = g; break; } }
    if (!gp) { releaseAll(); return; }

    const steerAxis = CFG.steerStick === 'right' ? 2 : 0;
    updateSteering(gp.axes[steerAxis] ?? 0);

    pressKey('accel',   (gp.buttons[CFG.accelBtn]?.value  ?? 0) > CFG.triggerMin);
    pressKey('brake',   (gp.buttons[CFG.brakeBtn]?.value  ?? 0) > CFG.triggerMin);
    pressKey('respawn',  gp.buttons[CFG.respawnBtn]?.pressed ?? false);
    pressKey('c',        gp.buttons[CFG.cBtn]?.pressed      ?? false);
  }

  /* Hook game loop — injected before game scripts so rAF is intercepted */
  let hooked = false;
  const _rAF = window.requestAnimationFrame;
  const _setInterval = window.setInterval;

  window.requestAnimationFrame = function (fn) {
    const id = _rAF.call(this, fn);
    if (!hooked) {
      hooked = true;
      (function rafTick() { tick(); _rAF(rafTick); })();
    }
    return id;
  };

  window.setInterval = function (fn, delay, ...args) {
    const id = _setInterval.apply(this, [fn, delay, ...args]);
    if (!hooked && typeof delay === 'number' && delay <= 2) {
      hooked = true;
      _setInterval(tick, delay);
    }
    return id;
  };

  /* Expose config for console tweaking */
  window.PolyTrackController = { CFG, releaseAll };
})();