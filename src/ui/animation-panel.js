// The Animation panel: clip list, transport, scrubber, speed, loop.
//
// The whole section hides itself when a model has no clips, which is most of
// them — a static product model should not be showing a dead transport.

const $ = (id) => document.getElementById(id);

/** Seconds as "1.23 / 4.56s". */
function formatTime(time, duration) {
  return `${time.toFixed(2)} / ${duration.toFixed(2)}s`;
}

/**
 * @param {object} options
 * @param {object} options.viewer
 */
export function createAnimationPanel({ viewer, onRebuild = () => {} }) {
  const group = $('animationGroup');
  const clipSelect = $('clipSelect');
  const playPause = $('playPause');
  const timeline = $('timeline');
  const timeOut = $('timeOut');
  const countEl = $('clipCount');

  // While the user is dragging the playhead, playback must not write to the
  // same slider underneath them.
  let scrubbing = false;

  function animation() {
    return viewer.animation;
  }

  function syncTransport() {
    const anim = animation();
    if (!anim) return;
    playPause.textContent = anim.playing ? '❚❚ Pause' : '▶ Play';
    playPause.setAttribute('aria-label', anim.playing ? 'Pause' : 'Play');
  }

  function syncTime(time = animation()?.time ?? 0, duration = animation()?.duration ?? 0) {
    if (!scrubbing) timeline.value = String(duration > 0 ? time / duration : 0);
    timeOut.textContent = formatTime(time, duration);
  }

  /** Rebuild for a newly loaded model. */
  function rebuild() {
    const anim = animation();

    // Hidden rather than disabled: a static model has no animation, and an
    // empty transport is noise.
    group.hidden = !anim;
    // Lets the tab bar drop a tab whose sections have all hidden themselves —
    // called here, unconditionally, since #animationGroup's own `hidden` is
    // now final either way this function proceeds.
    onRebuild();
    if (!anim) return;

    countEl.textContent = anim.clips.length > 1 ? `(${anim.clips.length})` : '';

    clipSelect.replaceChildren();
    for (const [i, name] of anim.names.entries()) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = name;
      clipSelect.appendChild(option);
    }
    clipSelect.value = String(anim.index);
    // A single clip has nothing to choose between.
    clipSelect.closest('.row').hidden = anim.clips.length < 2;

    $('animSpeed').value = String(anim.speed);
    $('animSpeedOut').textContent = `${anim.speed.toFixed(2)}×`;
    $('animLoop').checked = anim.looping;

    syncTransport();
    syncTime();
  }

  // --- wiring --------------------------------------------------------------

  clipSelect.addEventListener('change', () => {
    animation()?.select(parseInt(clipSelect.value, 10));
    syncTransport();
    syncTime();
  });

  playPause.addEventListener('click', () => {
    animation()?.toggle();
    syncTransport();
  });

  // pointerdown/up rather than the input event, so the flag covers the whole
  // drag including the gap between moves.
  timeline.addEventListener('pointerdown', () => { scrubbing = true; });
  timeline.addEventListener('pointerup', () => { scrubbing = false; });
  timeline.addEventListener('pointercancel', () => { scrubbing = false; });

  timeline.addEventListener('input', () => {
    const anim = animation();
    if (!anim) return;
    const time = parseFloat(timeline.value) * anim.duration;
    anim.seek(time);
    timeOut.textContent = formatTime(time, anim.duration);
  });

  // Keyboard scrubbing fires input without any pointer events, so make sure the
  // flag cannot be left stuck on.
  timeline.addEventListener('keydown', () => { scrubbing = false; });

  $('animSpeed').addEventListener('input', (event) => {
    const value = parseFloat(event.target.value);
    animation()?.setSpeed(value);
    $('animSpeedOut').textContent = `${value.toFixed(2)}×`;
  });

  $('animLoop').addEventListener('change', (event) => {
    animation()?.setLooping(event.target.checked);
  });

  // The viewer drives these: one when a model loads, one per frame while
  // playing so the playhead follows.
  viewer.onAnimationChange(rebuild);
  viewer.onAnimationTick((time, duration) => {
    syncTime(time, duration);
    // A non-looping clip pauses itself at the end; keep the button honest.
    if (!animation()?.playing) syncTransport();
  });

  return { rebuild, syncTransport, syncTime };
}
