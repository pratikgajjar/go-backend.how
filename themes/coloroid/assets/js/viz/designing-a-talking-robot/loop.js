/*
 * One playback loop for the post's figures (sys.js, procs.js, sync.js).
 *
 * It paints at most 30 times a second (the motion data is 30 fps) on the
 * display clock: it sleeps on a timer for most of a 30 fps step, then takes
 * the first display frame that starts a full step after the last paint. A
 * 60 Hz screen wakes it about twice per paint; a 120 Hz screen too, not 4x.
 * It does no work while the element is off screen or the tab is hidden, and
 * none at all when step() returns false or stop() is called.
 */

import { onVisible } from '../lib.js';

export const FRAME_MS = 1000 / 30;

/* Milliseconds to sleep before the loop asks for display frames again. The
   display clock decides when to paint: a frame that starts less than one
   30 fps step after the last paint is skipped. The timer only saves the
   frames in between on fast (90-144 Hz) screens; it wakes a little early,
   because a rAF request made during a frame may join that frame. */
export const wakeIn = (lastPaint) => lastPaint + FRAME_MS - 12 - performance.now();

/**
 * step(dtSeconds, now) paints one frame; it returns false to stop. dt is 0
 * on the first frame after a start or a pause (no jump), and at most 0.1 s.
 * Returns { start(), stop(), on }.
 */
export function playLoop(el, step) {
  let raf = 0, wait = 0, last = 0, lastPaint = -1e9, on = false, seen = false;
  const want = () => on && seen && !document.hidden;
  function sleep() {
    if (raf || wait || !want()) return;
    const left = wakeIn(lastPaint);
    if (left > 1) wait = setTimeout(() => { wait = 0; sleep(); }, left);
    else raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (!want()) return;
    // too early for the next 30 fps step: wait one more display frame
    if (now - lastPaint < FRAME_MS - 3) { raf = requestAnimationFrame(frame); return; }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = lastPaint = now;
    if (step(dt, now) === false) { on = false; return; }
    sleep();
  }
  function halt() {
    cancelAnimationFrame(raf);
    clearTimeout(wait);
    raf = wait = last = 0;
  }
  onVisible(el, (v) => { seen = v; if (v) sleep(); else halt(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) halt(); else sleep(); });
  return {
    start() { if (!on) { on = true; last = 0; } sleep(); },
    stop() { on = false; halt(); },
    get on() { return on; },
  };
}
