import type { System } from '@/libs/browser';

import { getKeycode, isModifier } from './keymap';
import {
  mapModifier,
  matchChord,
  matchRule,
  type HostAction,
  type HostMods,
  type ModifierOverride,
  type RemapContext
} from './remap-config';

export type { HostMods } from './remap-config';

/**
 * Pure keyboard state machine (spec §3.3). Translates host key events into HID
 * actions; the driver owns the state object and runs the actions in order.
 */
export type HostKeyEvent =
  | {
      type: 'keydown';
      code: string;
      key?: string;
      repeat: boolean;
      timeStamp: number;
      mods: HostMods;
    }
  | { type: 'keyup'; code: string; timeStamp: number; mods: HostMods }
  | { type: 'timer'; code: string; timeStamp: number }
  | { type: 'release-all' };

export type HidAction =
  | { type: 'press'; code: string }
  | { type: 'release'; code: string }
  | { type: 'reset' }
  | { type: 'release-after'; code: string; ms: number }
  | { type: 'cancel-release'; code: string }
  | { type: 'cancel-all-timers' }
  | { type: 'host-action'; id: HostAction['id'] }
  | { type: 'hint'; id: 'ime-composing' }
  | { type: 'trace'; ev: HostKeyEvent; sent: string[] };

export type Logical = 'ctrl' | 'alt' | 'shift' | 'meta';

export interface KeyEntry {
  kind: 'mod' | 'key' | 'consumed';
  /** HID code chosen at keydown time (frozen so a release always matches its press). */
  out: string;
  /** A release-after timer was scheduled (key pressed under ⌘, or CapsLock fix). */
  tap: boolean;
  /** `out` already released (tap finished) while the host key may still be down. */
  released: boolean;
  pressedAt: number;
  /** Created by the modifier resync, not by a host keydown. */
  synthetic?: boolean;
  /** Per-key modifier override of a rule; active while the entry is unreleased. */
  override?: ModifierOverride;
}

export interface RemapState {
  hostOS: System;
  /** host code → entry, insertion ordered (upstream `pressedKeys` and more). */
  keys: Map<string, KeyEntry>;
  /** Modifier HID codes currently down on the wire. */
  wireMods: Set<string>;
  /** Logicals suppressed by a finished override, re-pressed lazily at the next non-modifier keydown. */
  deferred: Set<Logical>;
  /** ⌘ released while a tap was younger than minPressMs: the sweep waits for the tap timers. */
  sweepPending: boolean;
  /** Windows host only (upstream AltGr hack). */
  altGr: { active: boolean; ctrlLeftTimestamp: number } | null;
}

const ALTGR_THRESHOLD_MS = 10;
const LOGICALS: readonly Logical[] = ['meta', 'ctrl', 'alt', 'shift'];
const CANONICAL: Record<Logical, string> = {
  meta: 'MetaLeft',
  ctrl: 'ControlLeft',
  alt: 'AltLeft',
  shift: 'ShiftLeft'
};

export function logicalOf(code: string): Logical | null {
  switch (code) {
    case 'ControlLeft':
    case 'ControlRight':
      return 'ctrl';
    case 'AltLeft':
    case 'AltRight':
      return 'alt';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'shift';
    case 'MetaLeft':
    case 'MetaRight':
      return 'meta';
    default:
      return null;
  }
}

const isMetaCode = (code: string): boolean => code === 'MetaLeft' || code === 'MetaRight';

export function createRemapState(hostOS: System): RemapState {
  return {
    hostOS,
    keys: new Map(),
    wireMods: new Set(),
    deferred: new Set(),
    sweepPending: false,
    altGr: hostOS === 'Windows' ? { active: false, ctrlLeftTimestamp: 0 } : null
  };
}

/** Action buckets: key releases → modifier reconcile → key presses/timers. */
interface Buckets {
  rel: HidAction[];
  mid: HidAction[];
  post: HidAction[];
}

/** Modifiers physically held on the host, derived from mod entries by HOST code. */
function physicalMods(st: RemapState): HostMods {
  const mods: HostMods = { meta: false, ctrl: false, alt: false, shift: false };
  for (const [hostCode, entry] of st.keys) {
    if (entry.kind !== 'mod') continue;
    const logical = logicalOf(hostCode);
    if (logical) mods[logical] = true;
  }
  return mods;
}

function hasModOut(st: RemapState, logical: Logical): boolean {
  for (const entry of st.keys.values()) {
    if (entry.kind === 'mod' && !entry.released && logicalOf(entry.out) === logical) return true;
  }
  return false;
}

function hasUnreleasedTap(st: RemapState): boolean {
  for (const entry of st.keys.values()) {
    if (entry.kind === 'key' && entry.tap && !entry.released) return true;
  }
  return false;
}

function hasYoungTap(st: RemapState, now: number, minPressMs: number): boolean {
  if (minPressMs <= 0) return false;
  for (const entry of st.keys.values()) {
    if (
      entry.kind === 'key' &&
      entry.tap &&
      !entry.released &&
      now - entry.pressedAt < minPressMs
    ) {
      return true;
    }
  }
  return false;
}

/** The override of a finished/released key entry ends: defer the modifiers it suppressed. */
function endOverride(st: RemapState, entry: KeyEntry): void {
  const override = entry.override;
  if (!override) return;
  entry.override = undefined;
  for (const logical of LOGICALS) {
    if (override[logical] === false && hasModOut(st, logical)) st.deferred.add(logical);
  }
}

/** Spec §3.3 step 5. */
function finishEntry(st: RemapState, hostCode: string, b: Buckets): void {
  const entry = st.keys.get(hostCode);
  if (!entry) return;
  st.keys.delete(hostCode);
  if (entry.kind === 'key') {
    if (!entry.released) {
      b.rel.push({ type: 'release', code: entry.out });
      if (entry.tap) b.rel.push({ type: 'cancel-release', code: hostCode });
    }
    endOverride(st, entry);
  } else if (entry.kind === 'mod') {
    const logical = logicalOf(entry.out);
    if (logical) st.deferred.delete(logical);
  }
}

/** Upstream ⌘-up sweep: finish every non-modifier entry (insertion order). */
function sweep(st: RemapState, b: Buckets): void {
  for (const [hostCode, entry] of [...st.keys]) {
    if (entry.kind === 'key') finishEntry(st, hostCode, b);
  }
}

/** Complete a deferred sweep: remaining keys, then the ⌘ entries themselves. */
function flushSweep(st: RemapState, b: Buckets): void {
  sweep(st, b);
  for (const [hostCode, entry] of [...st.keys]) {
    if (entry.kind === 'mod' && isMetaCode(hostCode)) finishEntry(st, hostCode, b);
  }
  st.sweepPending = false;
}

/**
 * Spec §3.3 step 2d/3b: realign tracked modifiers with the host flags (macOS
 * host only, never while AltGr is active). On keydown the event's own logical
 * is skipped entirely; on keyup only the event's own code is excluded, so a
 * synthetic entry of the same logical is retired by the keyup.
 */
function resync(
  st: RemapState,
  ctx: RemapContext,
  mods: HostMods,
  ownCode: string,
  isKeydown: boolean,
  now: number,
  b: Buckets
): void {
  if (st.hostOS !== 'macOS' || st.altGr?.active) return;
  const ownLogical = logicalOf(ownCode);
  for (const logical of LOGICALS) {
    if (isKeydown && logical === ownLogical) continue;
    // a deferred ⌘-up sweep owns the ⌘ entries until the young taps are released
    if (logical === 'meta' && st.sweepPending) continue;
    const have: string[] = [];
    for (const [hostCode, entry] of st.keys) {
      if (entry.kind === 'mod' && logicalOf(hostCode) === logical) have.push(hostCode);
    }
    if (mods[logical]) {
      if (logical !== ownLogical && have.length === 0) {
        const code = CANONICAL[logical];
        st.keys.set(code, {
          kind: 'mod',
          out: mapModifier(code, ctx.active),
          tap: false,
          released: false,
          pressedAt: now,
          synthetic: true
        });
      }
    } else {
      const stale = have.filter((hostCode) => hostCode !== ownCode);
      if (stale.length === 0) continue;
      if (logical === 'meta') sweep(st, b);
      for (const hostCode of stale) finishEntry(st, hostCode, b);
    }
  }
}

function capsLockFixApplies(st: RemapState, ctx: RemapContext, code: string): boolean {
  return code === 'CapsLock' && st.hostOS === 'macOS' && ctx.active && ctx.cfg.macCapsLockFix;
}

function tapCapsLock(st: RemapState, ctx: RemapContext, now: number, b: Buckets): void {
  finishEntry(st, 'CapsLock', b);
  st.keys.set('CapsLock', {
    kind: 'key',
    out: 'CapsLock',
    tap: true,
    released: false,
    pressedAt: now
  });
  b.post.push({ type: 'press', code: 'CapsLock' });
  b.post.push({ type: 'release-after', code: 'CapsLock', ms: ctx.cfg.tapReleaseMs });
}

/** Upstream dedupe plus the tap repeat/re-press rule (spec §3.3 step 2e). */
function isDuplicate(entry: KeyEntry, repeat: boolean, repeatUnderMeta: boolean): boolean {
  return repeat ? !(repeatUnderMeta && entry.tap && entry.released) : !entry.released;
}

function onKeyDown(
  st: RemapState,
  ev: Extract<HostKeyEvent, { type: 'keydown' }>,
  ctx: RemapContext,
  b: Buckets
): void {
  const { code } = ev;
  const cfg = ctx.cfg;
  const now = ev.timeStamp;

  if (ev.key === 'Process') b.post.push({ type: 'hint', id: 'ime-composing' });

  // 2a. a deferred ⌘-up sweep completes before anything new is pressed
  if (st.sweepPending) flushSweep(st, b);

  const existing = st.keys.get(code);
  const duplicate =
    existing !== undefined &&
    existing.kind !== 'consumed' &&
    isDuplicate(existing, ev.repeat, cfg.repeatUnderMeta);

  // 2b. AltGr (Windows host only), verbatim upstream: ControlLeft followed by
  // AltRight within 10 ms is AltGr, so the ControlLeft is taken back first.
  if (st.altGr && !duplicate) {
    if (code === 'ControlLeft') {
      st.altGr.ctrlLeftTimestamp = now;
    } else if (code === 'AltRight') {
      const ctrl = st.keys.get('ControlLeft');
      if (now - st.altGr.ctrlLeftTimestamp < ALTGR_THRESHOLD_MS && ctrl?.kind === 'mod') {
        st.keys.delete('ControlLeft');
        if (st.wireMods.delete('ControlLeft')) b.rel.push({ type: 'release', code: 'ControlLeft' });
        st.altGr.active = true;
      }
    }
  }

  // 2c. host actions (consumed chords such as ⌘⇧V)
  if (!ev.repeat && ctx.active) {
    const action = ctx.hostActions.find(
      (candidate) =>
        candidate.enabled && matchChord({ code, mods: ev.mods, repeat: ev.repeat }, candidate.chord)
    );
    if (action) {
      if (existing && existing.kind !== 'consumed') finishEntry(st, code, b);
      st.keys.set(code, {
        kind: 'consumed',
        out: code,
        tap: false,
        released: false,
        pressedAt: now
      });
      b.post.push({ type: 'host-action', id: action.id });
      return;
    }
  }
  // A consumed entry swallows the chord's autorepeat. Its keyup never arrives
  // when the key was released under ⌘ (A1), so a fresh (non-repeat) keydown is
  // the next physical press: drop the stale entry and handle the key normally.
  if (existing?.kind === 'consumed') {
    if (ev.repeat) return;
    st.keys.delete(code);
  }

  // 2d. modifier resync
  resync(st, ctx, ev.mods, code, true, now, b);

  // 2e. dedupe / stale tap
  const entry = st.keys.get(code);
  if (entry) {
    if (isDuplicate(entry, ev.repeat, cfg.repeatUnderMeta)) return;
    finishEntry(st, code, b);
  }

  // 2f. CapsLock fix
  if (capsLockFixApplies(st, ctx, code)) {
    tapCapsLock(st, ctx, now, b);
    return;
  }

  // 2g. modifier. A physical press of a deferred logical ends its deferral:
  // the lazy re-press is for keys; a user pressing the modifier again wants it
  // down now (⌘-click = Ctrl+click right after a ⌘← tap).
  if (isModifier(code)) {
    const out = mapModifier(code, ctx.active);
    const logical = logicalOf(out);
    if (logical) st.deferred.delete(logical);
    st.keys.set(code, {
      kind: 'mod',
      out,
      tap: false,
      released: false,
      pressedAt: now
    });
    return;
  }

  // 2h. non-modifier
  const mods = physicalMods(st);
  const rule = matchRule(ctx, mods, code, ev.key);
  const out = rule?.emit ?? code;
  if (getKeycode(out) === undefined) return;
  for (const [hostCode, other] of [...st.keys]) {
    if (hostCode !== code && other.kind === 'key' && other.out === out)
      finishEntry(st, hostCode, b);
  }
  const tap = ctx.active && mods.meta;
  if (rule) {
    for (const [hostCode, other] of [...st.keys]) {
      if (other.kind === 'key' && other.tap && !other.released) finishEntry(st, hostCode, b);
    }
  }
  st.deferred.clear();
  st.keys.set(code, {
    kind: 'key',
    out,
    tap,
    released: false,
    pressedAt: now,
    override: rule?.mods
  });
  b.post.push({ type: 'press', code: out });
  if (tap) b.post.push({ type: 'release-after', code, ms: cfg.tapReleaseMs });
}

function onKeyUp(
  st: RemapState,
  ev: Extract<HostKeyEvent, { type: 'keyup' }>,
  ctx: RemapContext,
  b: Buckets
): void {
  const { code } = ev;
  const now = ev.timeStamp;

  // 3a. consumed chords and AltGr
  const existing = st.keys.get(code);
  if (existing?.kind === 'consumed') {
    st.keys.delete(code);
    return;
  }
  if (st.altGr?.active) {
    if (code === 'ControlLeft') return;
    if (code === 'AltRight') st.altGr.active = false;
  }

  // 3b. modifier resync (retires synthetic entries of the released logical)
  resync(st, ctx, ev.mods, code, false, now, b);

  // 3c. CapsLock fix: keyup (lock off) taps as well
  if (capsLockFixApplies(st, ctx, code)) {
    tapCapsLock(st, ctx, now, b);
    return;
  }

  if (isMetaCode(code)) {
    // 3d. ⌘-up sweep, deferred while a tap is younger than minPressMs
    if (ctx.active && hasYoungTap(st, now, ctx.cfg.minPressMs)) {
      st.sweepPending = true;
    } else {
      sweep(st, b);
      finishEntry(st, code, b);
    }
  } else if (st.sweepPending && existing?.kind === 'key' && existing.tap && !existing.released) {
    // keyup of a tap during a deferred sweep: its timer releases it (minPressMs)
  } else {
    // 3e. own entry
    finishEntry(st, code, b);
  }

  if (st.sweepPending && !hasUnreleasedTap(st)) flushSweep(st, b);
}

function onTimer(st: RemapState, ev: Extract<HostKeyEvent, { type: 'timer' }>, b: Buckets): void {
  const entry = st.keys.get(ev.code);
  if (entry && entry.kind === 'key' && entry.tap && !entry.released) {
    b.rel.push({ type: 'release', code: entry.out });
    entry.released = true;
    endOverride(st, entry);
  }
  if (st.sweepPending && !hasUnreleasedTap(st)) flushSweep(st, b);
}

/**
 * Spec §3.3 step 6: recompute the modifier set the wire should carry and emit
 * only the differences, presses first (Ctrl↓ before Alt↑ masks a lone Alt).
 */
function reconcile(st: RemapState, b: Buckets): void {
  const desired: string[] = [];
  const add = (code: string): void => {
    if (!desired.includes(code)) desired.push(code);
  };
  const removeLogical = (logical: Logical): void => {
    for (let i = desired.length - 1; i >= 0; i--) {
      if (logicalOf(desired[i]) === logical) desired.splice(i, 1);
    }
  };
  for (const entry of st.keys.values()) {
    if (entry.kind === 'mod' && !entry.released) add(entry.out);
  }
  for (const entry of st.keys.values()) {
    if (entry.kind !== 'key' || entry.released || !entry.override) continue;
    for (const logical of LOGICALS) {
      const want = entry.override[logical];
      if (want === false) {
        removeLogical(logical);
      } else if (want === true && !desired.some((code) => logicalOf(code) === logical)) {
        add(CANONICAL[logical]);
      }
    }
  }
  for (const logical of st.deferred) removeLogical(logical);

  for (const code of desired) {
    if (!st.wireMods.has(code)) b.mid.push({ type: 'press', code });
  }
  for (const code of st.wireMods) {
    if (!desired.includes(code)) b.mid.push({ type: 'release', code });
  }
  st.wireMods = new Set(desired);
}

function sentCodes(actions: HidAction[]): string[] {
  const sent: string[] = [];
  for (const action of actions) {
    if (action.type === 'press') sent.push(`+${action.code}`);
    else if (action.type === 'release') sent.push(`-${action.code}`);
    else if (action.type === 'reset') sent.push('reset');
  }
  return sent;
}

/**
 * Translate one host event into HID actions, mutating `state` in place.
 * Action order per event: key releases → modifier reconcile (presses, then
 * releases) → key presses/timers → host action/hint → trace.
 */
export function translateKeyEvent(
  state: RemapState,
  ev: HostKeyEvent,
  ctx: RemapContext
): HidAction[] {
  if (ev.type === 'release-all') {
    Object.assign(state, createRemapState(state.hostOS));
    return [{ type: 'cancel-all-timers' }, { type: 'reset' }];
  }
  const b: Buckets = { rel: [], mid: [], post: [] };
  switch (ev.type) {
    case 'keydown':
      onKeyDown(state, ev, ctx, b);
      break;
    case 'keyup':
      onKeyUp(state, ev, ctx, b);
      break;
    case 'timer':
      onTimer(state, ev, b);
      break;
  }
  reconcile(state, b);
  const actions: HidAction[] = [...b.rel, ...b.mid, ...b.post];
  actions.push({ type: 'trace', ev, sent: sentCodes(actions) });
  return actions;
}
