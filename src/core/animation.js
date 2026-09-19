// Animation playback.
//
// The app used to do exactly this and nothing more:
//
//     mixer = new AnimationMixer(object);
//     mixer.clipAction(clips[0]).play();
//
// So a model's first clip autoplayed forever, every other clip was
// unreachable, and there was no way to pause, scrub or slow it down.
//
// Two things need care here.
//
// Scrubbing. AnimationMixer has no seek. The way to move to a time is to set
// the action's `time` and then advance the mixer by zero, which evaluates the
// tracks at that time without moving on.
//
// The render loop. Rendering is on demand, so a playing animation has to hold
// the loop open and release it when paused — otherwise playback would advance
// with nothing being drawn. Scrubbing while paused has to explicitly ask for
// the one frame that shows the new pose.

import { AnimationMixer, LoopRepeat, LoopOnce } from 'three';

/**
 * @param {object} options
 * @param {import('three').Object3D} options.root  The object the clips target.
 * @param {Array<import('three').AnimationClip>} options.clips
 * @param {object} options.loop      The render loop (hold/release/invalidate).
 * @param {() => void} [options.onShadowDirty]  Called when the pose changes.
 * @param {() => void} [options.onTick]  Called each frame while playing, for a
 *   UI that wants to follow the playhead.
 */
export function createAnimation({ root, clips, loop, onShadowDirty = () => {}, onTick = () => {} }) {
  const mixer = new AnimationMixer(root);

  let index = -1;
  let action = null;
  let playing = false;
  let speed = 1;
  let looping = true;

  /** Duration of the selected clip, in seconds. */
  function duration() {
    return clips[index]?.duration ?? 0;
  }

  function applyLoopMode() {
    if (!action) return;
    // Infinity repetitions for a loop; a single pass otherwise, held on its
    // final frame rather than snapping back to the start.
    action.setLoop(looping ? LoopRepeat : LoopOnce, looping ? Infinity : 1);
    action.clampWhenFinished = !looping;
  }

  /**
   * Select a clip by index. Stops whatever was playing.
   * @returns {boolean} false if the index is out of range.
   */
  function select(next) {
    if (next < 0 || next >= clips.length) return false;

    if (action) {
      action.stop();
      mixer.uncacheAction(clips[index], root);
    }

    index = next;
    action = mixer.clipAction(clips[index]);
    action.enabled = true;
    action.setEffectiveTimeScale(speed);
    action.setEffectiveWeight(1);
    applyLoopMode();
    action.play();
    // play() only marks it active; pausing here means selecting a clip shows
    // its first frame rather than immediately running away with it.
    action.paused = !playing;

    seek(0);
    return true;
  }

  function play() {
    if (!action || playing) return;
    // Restart from the beginning if a non-looping clip has run to its end,
    // otherwise pressing play on a finished clip does nothing visible.
    if (!looping && action.time >= duration() - 1e-4) seek(0);
    playing = true;
    action.paused = false;
    loop.hold('animation');
  }

  function pause() {
    if (!action || !playing) return;
    playing = false;
    action.paused = true;
    loop.release('animation');
  }

  function toggle() {
    if (playing) pause();
    else play();
  }

  /**
   * Jump to a time in seconds.
   *
   * AnimationMixer exposes no seek, so set the action's time and advance the
   * mixer by zero: that evaluates every track at the new time without moving
   * playback forward.
   */
  function seek(seconds) {
    if (!action) return;
    const clamped = Math.max(0, Math.min(seconds, duration()));
    action.time = clamped;
    mixer.update(0);
    onShadowDirty();
    // While paused nothing else will ask for a frame, so the new pose would
    // never be drawn.
    loop.invalidate(2);
  }

  function setSpeed(value) {
    speed = value;
    action?.setEffectiveTimeScale(value);
    // Speed 0 would otherwise hold the loop open rendering identical frames.
    if (playing && value === 0) loop.invalidate();
  }

  function setLooping(value) {
    looping = value;
    applyLoopMode();
  }

  /** Advance playback. Called from the render loop's update. */
  function update(delta) {
    if (!playing || !action) return;
    mixer.update(delta);
    onShadowDirty();
    onTick(action.time, duration());

    // A non-looping clip that has reached its end should return the UI to a
    // paused state rather than silently pinning the render loop open.
    if (!looping && action.time >= duration() - 1e-4) pause();
  }

  function dispose() {
    if (playing) loop.release('animation');
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    action = null;
    playing = false;
  }

  return {
    mixer,
    clips,
    update,
    dispose,
    select,
    play,
    pause,
    toggle,
    seek,
    setSpeed,
    setLooping,

    get index() {
      return index;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    get looping() {
      return looping;
    },
    get time() {
      return action?.time ?? 0;
    },
    get duration() {
      return duration();
    },
    /** Clip names for the UI, with a fallback for unnamed clips. */
    get names() {
      return clips.map((clip, i) => clip.name || `Clip ${i + 1}`);
    },
  };
}
