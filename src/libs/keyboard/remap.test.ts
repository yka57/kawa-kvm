import { describe, expect, it } from 'vitest';

import type { System } from '@/libs/browser';
import { makeKeyEvent, NO_MODS } from '@/test/fakes';

import { KeyboardReport } from './keyboard';
import { isModifier } from './keymap';
import {
  createRemapState,
  translateKeyEvent,
  type HidAction,
  type HostKeyEvent,
  type HostMods,
  type RemapState
} from './remap';
import {
  DEFAULT_REMAP_CONFIG,
  type HostAction,
  type KeyboardRemapConfig,
  type RemapContext
} from './remap-config';

type Mods = Partial<HostMods>;

const ctxOf = (
  active: boolean,
  cfg: Partial<KeyboardRemapConfig> = {},
  hostActions: HostAction[] = []
): RemapContext => ({
  // v1 (all ⌘ → Ctrl) unless a test asks for the split
  cfg: { ...DEFAULT_REMAP_CONFIG, cmdSplit: false, ...cfg },
  active,
  hostActions
});

const ON = ctxOf(true);
const OFF = ctxOf(false);

const down = (code: string, mods: Mods = {}, timeStamp = 0, repeat = false): HostKeyEvent =>
  makeKeyEvent({ code, mods: { ...NO_MODS, ...mods }, timeStamp, repeat });
const up = (code: string, mods: Mods = {}, timeStamp = 0): HostKeyEvent =>
  makeKeyEvent({ type: 'keyup', code, mods: { ...NO_MODS, ...mods }, timeStamp });
const timer = (code: string, timeStamp = 0): HostKeyEvent => ({ type: 'timer', code, timeStamp });
const RELEASE_ALL: HostKeyEvent = { type: 'release-all' };

/** Compact notation: +press -release ~release-after@ms xcancel-release. */
function fmt(action: HidAction): string {
  switch (action.type) {
    case 'press':
      return `+${action.code}`;
    case 'release':
      return `-${action.code}`;
    case 'reset':
      return 'reset';
    case 'release-after':
      return `~${action.code}@${action.ms}`;
    case 'cancel-release':
      return `x${action.code}`;
    case 'cancel-all-timers':
      return 'cancel-all';
    case 'host-action':
      return `host:${action.id}`;
    case 'hint':
      return `hint:${action.id}`;
    case 'trace':
      return 'trace';
  }
}

const wire = (actions: HidAction[]): string[] =>
  actions.filter((action) => action.type !== 'trace').map(fmt);

class Session {
  state: RemapState;

  constructor(
    hostOS: System,
    public ctx: RemapContext
  ) {
    this.state = createRemapState(hostOS);
  }

  /** Non-trace actions of one event, formatted. */
  run(ev: HostKeyEvent): string[] {
    return wire(translateKeyEvent(this.state, ev, this.ctx));
  }

  raw(ev: HostKeyEvent): HidAction[] {
    return translateKeyEvent(this.state, ev, this.ctx);
  }

  /** Concatenated non-trace actions of several events. */
  runAll(events: HostKeyEvent[]): string[] {
    return events.flatMap((ev) => this.run(ev));
  }
}

/** Fork reports: run the actions through KeyboardReport exactly like the driver does. */
function forkReports(hostOS: System, ctx: RemapContext, events: HostKeyEvent[]): number[][] {
  const state = createRemapState(hostOS);
  const kb = new KeyboardReport();
  const out: number[][] = [];
  for (const ev of events) {
    for (const action of translateKeyEvent(state, ev, ctx)) {
      if (action.type === 'press') out.push(kb.keyDown(action.code));
      else if (action.type === 'release') out.push(kb.keyUp(action.code));
      else if (action.type === 'reset') out.push(kb.reset());
    }
  }
  return out;
}

/**
 * Port of upstream src/components/keyboard/index.tsx handlers (dedupe set,
 * Windows AltGr hack, ⌘-up sweep) producing the report stream it would send.
 */
function upstreamReports(hostOS: System, events: HostKeyEvent[]): number[][] {
  const kb = new KeyboardReport();
  const pressed = new Set<string>();
  const altGr = hostOS === 'Windows' ? { active: false, ctrlLeftTimestamp: 0 } : null;
  const out: number[][] = [];
  for (const ev of events) {
    if (ev.type === 'keydown') {
      if (pressed.has(ev.code)) continue;
      if (altGr) {
        if (ev.code === 'ControlLeft') {
          altGr.ctrlLeftTimestamp = ev.timeStamp;
        } else if (
          ev.code === 'AltRight' &&
          ev.timeStamp - altGr.ctrlLeftTimestamp < 10 &&
          pressed.has('ControlLeft')
        ) {
          pressed.delete('ControlLeft');
          out.push(kb.keyUp('ControlLeft'));
          altGr.active = true;
        }
      }
      pressed.add(ev.code);
      out.push(kb.keyDown(ev.code));
    } else if (ev.type === 'keyup') {
      if (altGr?.active) {
        if (ev.code === 'ControlLeft') continue;
        if (ev.code === 'AltRight') altGr.active = false;
      }
      if (ev.code === 'MetaLeft' || ev.code === 'MetaRight') {
        for (const code of [...pressed]) {
          if (!isModifier(code)) {
            out.push(kb.keyUp(code));
            pressed.delete(code);
          }
        }
      }
      pressed.delete(ev.code);
      out.push(kb.keyUp(ev.code));
    }
  }
  return out;
}

const R = (modifier: number, ...keys: number[]): number[] => {
  const report = [modifier, 0, 0, 0, 0, 0, 0, 0];
  keys.forEach((key, i) => {
    report[2 + i] = key;
  });
  return report;
};

describe('upstream parity (remap off)', () => {
  it('⌘C on a macOS host: press MetaLeft, press KeyC, release KeyC, release MetaLeft', () => {
    const events = [down('MetaLeft', { meta: true }), down('KeyC', { meta: true }), up('MetaLeft')];
    const s = new Session('macOS', OFF);
    expect(s.run(events[0])).toEqual(['+MetaLeft']);
    expect(s.run(events[1])).toEqual(['+KeyC']);
    expect(s.run(events[2])).toEqual(['-KeyC', '-MetaLeft']);
    expect(forkReports('macOS', OFF, events)).toEqual(upstreamReports('macOS', events));
    expect(forkReports('macOS', OFF, events)).toEqual([R(0x08), R(0x08, 0x06), R(0x08), R(0)]);
  });

  it('Meta-up sweep on a Windows host releases every non-modifier in press order, then Meta', () => {
    const events = [
      down('MetaLeft', { meta: true }),
      down('KeyC', { meta: true }),
      down('KeyV', { meta: true }),
      up('MetaLeft')
    ];
    const s = new Session('Windows', OFF);
    expect(s.runAll(events)).toEqual([
      '+MetaLeft',
      '+KeyC',
      '+KeyV',
      '-KeyC',
      '-KeyV',
      '-MetaLeft'
    ]);
    expect(forkReports('Windows', OFF, events)).toEqual(upstreamReports('Windows', events));
  });

  it('Windows AltGr within 10 ms: ControlLeft released before AltRight, its keyup swallowed', () => {
    const events = [
      down('ControlLeft', { ctrl: true }, 0),
      down('AltRight', { ctrl: true, alt: true }, 5),
      down('KeyQ', { ctrl: true, alt: true }, 6),
      up('KeyQ', { ctrl: true, alt: true }, 100),
      up('ControlLeft', { alt: true }, 101),
      up('AltRight', {}, 102)
    ];
    const s = new Session('Windows', OFF);
    expect(s.run(events[0])).toEqual(['+ControlLeft']);
    expect(s.run(events[1])).toEqual(['-ControlLeft', '+AltRight']);
    expect(s.run(events[2])).toEqual(['+KeyQ']);
    expect(s.run(events[3])).toEqual(['-KeyQ']);
    expect(s.run(events[4])).toEqual([]);
    expect(s.run(events[5])).toEqual(['-AltRight']);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.state.keys.size).toBe(0);
    expect(forkReports('Windows', OFF, events)).toEqual(upstreamReports('Windows', events));
    expect(forkReports('Windows', OFF, events)).toEqual([
      R(0x01),
      R(0),
      R(0x40),
      R(0x40, 0x14),
      R(0x40),
      R(0)
    ]);
  });

  it('Windows AltRight 15 ms after ControlLeft is a plain Ctrl+AltRight chord', () => {
    const events = [
      down('ControlLeft', { ctrl: true }, 0),
      down('AltRight', { ctrl: true, alt: true }, 15),
      down('KeyQ', { ctrl: true, alt: true }, 16),
      up('KeyQ', { ctrl: true, alt: true }, 100),
      up('ControlLeft', { alt: true }, 101),
      up('AltRight', {}, 102)
    ];
    const s = new Session('Windows', OFF);
    expect(s.runAll(events)).toEqual([
      '+ControlLeft',
      '+AltRight',
      '+KeyQ',
      '-KeyQ',
      '-ControlLeft',
      '-AltRight'
    ]);
    expect(forkReports('Windows', OFF, events)).toEqual(upstreamReports('Windows', events));
  });

  it('the AltGr hack does not exist on a macOS host', () => {
    const events = [
      down('ControlLeft', { ctrl: true }, 0),
      down('AltRight', { ctrl: true, alt: true }, 5)
    ];
    expect(new Session('macOS', OFF).runAll(events)).toEqual(['+ControlLeft', '+AltRight']);
    expect(forkReports('macOS', OFF, events)).toEqual(upstreamReports('macOS', events));
  });

  it('CapsLock is a plain press/release when the remap is off (even with the fix enabled)', () => {
    const events = [down('CapsLock'), up('CapsLock')];
    expect(new Session('macOS', OFF).runAll(events)).toEqual(['+CapsLock', '-CapsLock']);
    expect(forkReports('macOS', OFF, events)).toEqual(upstreamReports('macOS', events));
  });

  it('shifted typing and held-key repeats match upstream (dedupe by pressed code)', () => {
    const events = [
      down('ShiftLeft', { shift: true }, 0),
      down('KeyA', { shift: true }, 10),
      down('KeyA', { shift: true }, 40, true),
      down('ShiftLeft', { shift: true }, 45, true),
      up('KeyA', { shift: true }, 60),
      up('ShiftLeft', {}, 70)
    ];
    expect(new Session('macOS', OFF).runAll(events)).toEqual([
      '+ShiftLeft',
      '+KeyA',
      '-KeyA',
      '-ShiftLeft'
    ]);
    expect(forkReports('macOS', OFF, events)).toEqual(upstreamReports('macOS', events));
  });

  it('release-all yields cancel-all-timers + reset and a fresh state (AltGr included)', () => {
    for (const hostOS of ['macOS', 'Windows'] as const) {
      const s = new Session(hostOS, OFF);
      s.runAll([down('ControlLeft', { ctrl: true }, 0), down('KeyC', { ctrl: true }, 1)]);
      if (hostOS === 'Windows') s.run(down('AltRight', { ctrl: true, alt: true }, 2));
      expect(s.run(RELEASE_ALL)).toEqual(['cancel-all', 'reset']);
      expect(s.state).toEqual(createRemapState(hostOS));
      expect(s.state.wireMods.size).toBe(0);
    }
  });
});

describe('active: taps under ⌘', () => {
  it('⌘C, timer path: one Ctrl+C, nothing held', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('MetaLeft', { meta: true }, 0))).toEqual(['+ControlLeft']);
    expect(s.run(down('KeyC', { meta: true }, 10))).toEqual(['+KeyC', '~KeyC@50']);
    expect(s.run(timer('KeyC', 60))).toEqual(['-KeyC']);
    expect(s.run(up('MetaLeft', {}, 500))).toEqual(['-ControlLeft']);
    expect(s.state.keys.size).toBe(0);
    expect(s.state.wireMods.size).toBe(0);
    expect(
      forkReports('macOS', ON, [
        down('MetaLeft', { meta: true }, 0),
        down('KeyC', { meta: true }, 10),
        timer('KeyC', 60),
        up('MetaLeft', {}, 500)
      ])
    ).toEqual([R(0x01), R(0x01, 0x06), R(0x01), R(0)]);
  });

  it('⌘C, ⌘-up before the timer: release KeyC, cancel-release, release ControlLeft', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 10)]);
    expect(s.run(up('MetaLeft', {}, 45))).toEqual(['-KeyC', 'xKeyC', '-ControlLeft']);
    expect(s.run(up('KeyC', {}, 60))).toEqual([]);
    expect(s.state.keys.size).toBe(0);
  });

  it('a keyup for the tapped key after the tap finished yields no actions', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 10)]);
    s.run(timer('KeyC', 60));
    expect(s.run(up('KeyC', { meta: true }, 70))).toEqual([]);
    expect(s.run(up('MetaLeft', {}, 80))).toEqual(['-ControlLeft']);
  });

  it('repeat=true re-taps only after the previous tap finished (repeatUnderMeta)', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyV', { meta: true }, 0)]);
    expect(s.run(down('KeyV', { meta: true }, 30, true))).toEqual([]);
    expect(s.run(timer('KeyV', 50))).toEqual(['-KeyV']);
    expect(s.run(down('KeyV', { meta: true }, 90, true))).toEqual(['+KeyV', '~KeyV@50']);
    expect(s.run(down('KeyV', { meta: true }, 120, true))).toEqual([]);
    expect(s.run(up('MetaLeft', {}, 2000))).toEqual(['-KeyV', 'xKeyV', '-ControlLeft']);
  });

  it('repeat=true is swallowed entirely when repeatUnderMeta is off', () => {
    const s = new Session('macOS', ctxOf(true, { repeatUnderMeta: false }));
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyV', { meta: true }, 0)]);
    s.run(timer('KeyV', 50));
    expect(s.run(down('KeyV', { meta: true }, 90, true))).toEqual([]);
    expect(s.run(down('KeyV', { meta: true }, 180, true))).toEqual([]);
  });

  it('repeat=false while the entry is released is a physical re-press: new tap', () => {
    const s = new Session('macOS', ctxOf(true, { repeatUnderMeta: false }));
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyV', { meta: true }, 0)]);
    s.run(timer('KeyV', 50));
    expect(s.run(down('KeyV', { meta: true }, 90))).toEqual(['+KeyV', '~KeyV@50']);
  });

  it('keys pressed without ⌘ keep held semantics (physical ⌃C unchanged)', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('ControlLeft', { ctrl: true }, 0))).toEqual(['+ControlLeft']);
    expect(s.run(down('KeyC', { ctrl: true }, 10))).toEqual(['+KeyC']);
    expect(s.run(down('KeyC', { ctrl: true }, 40, true))).toEqual([]);
    expect(s.run(up('KeyC', { ctrl: true }, 100))).toEqual(['-KeyC']);
    expect(s.run(up('ControlLeft', {}, 110))).toEqual(['-ControlLeft']);
  });

  it('two keys under ⌘ have independent taps; ⌘-up sweeps what is still down', () => {
    const s = new Session('macOS', ON);
    s.run(down('MetaLeft', { meta: true }, 0));
    expect(s.run(down('KeyK', { meta: true }, 10))).toEqual(['+KeyK', '~KeyK@50']);
    expect(s.run(down('KeyS', { meta: true }, 30))).toEqual(['+KeyS', '~KeyS@50']);
    expect(s.run(timer('KeyK', 60))).toEqual(['-KeyK']);
    expect(s.run(up('MetaLeft', {}, 70))).toEqual(['-KeyS', 'xKeyS', '-ControlLeft']);
  });
});

describe('active: right-hand modifiers and resync', () => {
  it('keydown MetaRight yields exactly press ControlRight; keyup releases it', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('MetaRight', { meta: true }))).toEqual(['+ControlRight']);
    expect(s.run(up('MetaRight'))).toEqual(['-ControlRight']);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.state.keys.size).toBe(0);
  });

  it.each([
    ['ShiftRight', 'shift'],
    ['ControlRight', 'ctrl'],
    ['AltRight', 'alt']
  ] as const)('%s press+release leaves nothing on the wire', (code, logical) => {
    const s = new Session('macOS', ON);
    expect(s.run(down(code, { [logical]: true }))).toEqual([`+${code}`]);
    expect(s.run(up(code))).toEqual([`-${code}`]);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.state.keys.size).toBe(0);
  });

  it('a key arriving with metaKey but no ⌘ entry synthesizes Ctrl; keyup MetaRight retires it', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('KeyV', { meta: true }, 0))).toEqual(['+ControlLeft', '+KeyV', '~KeyV@50']);
    expect(s.state.keys.get('MetaLeft')?.synthetic).toBe(true);
    expect(s.run(up('MetaRight', {}, 100))).toEqual(['-KeyV', 'xKeyV', '-ControlLeft']);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.state.keys.size).toBe(0);
  });

  it('⌘ released while unfocused: the next keydown without metaKey sweeps and drops Ctrl first', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 10)]);
    expect(s.run(down('KeyA', {}, 500))).toEqual(['-KeyC', 'xKeyC', '-ControlLeft', '+KeyA']);
    expect(s.run(up('KeyA', {}, 600))).toEqual(['-KeyA']);
  });

  it('Windows host: AltGr+KeyQ with ctrlKey=true never re-adds ControlLeft (no resync)', () => {
    const s = new Session('Windows', OFF);
    s.runAll([
      down('ControlLeft', { ctrl: true }, 0),
      down('AltRight', { ctrl: true, alt: true }, 5)
    ]);
    expect(s.run(down('KeyQ', { ctrl: true, alt: true }, 6))).toEqual(['+KeyQ']);
    expect(s.run(up('KeyQ', { ctrl: true, alt: true }, 50))).toEqual(['-KeyQ']);
    expect(s.state.wireMods.has('ControlLeft')).toBe(false);
  });

  it('physical ControlLeft + MetaLeft: ControlLeft stays until ControlLeft itself goes up', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('ControlLeft', { ctrl: true }, 0))).toEqual(['+ControlLeft']);
    expect(s.run(down('MetaLeft', { ctrl: true, meta: true }, 10))).toEqual([]);
    expect(s.run(up('MetaLeft', { ctrl: true }, 20))).toEqual([]);
    expect(s.state.wireMods.has('ControlLeft')).toBe(true);
    expect(s.run(up('ControlLeft', {}, 30))).toEqual(['-ControlLeft']);
    expect(s.state.wireMods.size).toBe(0);
  });
});

describe('active: optWord (⌥←) with lone-Alt masking and lazy re-press', () => {
  it('⌥← then ⌥-up: press AltLeft, press ControlLeft, release AltLeft, press/release ArrowLeft, release ControlLeft', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('AltLeft', { alt: true }, 0))).toEqual(['+AltLeft']);
    expect(s.run(down('ArrowLeft', { alt: true }, 10))).toEqual([
      '+ControlLeft',
      '-AltLeft',
      '+ArrowLeft'
    ]);
    expect(s.run(up('ArrowLeft', { alt: true }, 100))).toEqual(['-ArrowLeft', '-ControlLeft']);
    expect(s.state.deferred.has('alt')).toBe(true);
    expect(s.run(up('AltLeft', {}, 200))).toEqual([]);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.state.deferred.size).toBe(0);
    expect(
      forkReports('macOS', ON, [
        down('AltLeft', { alt: true }, 0),
        down('ArrowLeft', { alt: true }, 10),
        up('ArrowLeft', { alt: true }, 100),
        up('AltLeft', {}, 200)
      ])
    ).toEqual([R(0x04), R(0x05), R(0x01), R(0x01, 0x50), R(0x01), R(0)]);
  });

  it('a second ⌥← while ⌥ is held: the deferred Alt is re-suppressed by the rule, so only Ctrl returns', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('AltLeft', { alt: true }, 0),
      down('ArrowLeft', { alt: true }, 10),
      up('ArrowLeft', { alt: true }, 100)
    ]);
    // The lazy re-press and the rule's alt:false override cancel out: AltLeft
    // never comes back to the wire, so there is no lone-Alt tap to mask.
    const second = s.run(down('ArrowLeft', { alt: true }, 300));
    expect(second).toEqual(['+ControlLeft', '+ArrowLeft']);
    expect(second.some((a) => a.includes('AltLeft'))).toBe(false);
    expect(s.run(up('ArrowLeft', { alt: true }, 400))).toEqual(['-ArrowLeft', '-ControlLeft']);
    expect(s.run(up('AltLeft', {}, 500))).toEqual([]);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('a non-rule key after ⌥← re-presses the deferred Alt right before the key', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('AltLeft', { alt: true }, 0),
      down('ArrowLeft', { alt: true }, 10),
      up('ArrowLeft', { alt: true }, 100)
    ]);
    expect(s.run(down('KeyA', { alt: true }, 300))).toEqual(['+AltLeft', '+KeyA']);
    expect(s.run(up('KeyA', { alt: true }, 400))).toEqual(['-KeyA']);
    expect(s.run(up('AltLeft', {}, 500))).toEqual(['-AltLeft']);
  });

  it('⌥← held: the override persists (target autorepeats Ctrl+←) until the keyup', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('AltLeft', { alt: true }, 0), down('ArrowLeft', { alt: true }, 10)]);
    expect(s.run(down('ArrowLeft', { alt: true }, 500, true))).toEqual([]);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft']));
    expect(s.run(up('ArrowLeft', { alt: true }, 800))).toEqual(['-ArrowLeft', '-ControlLeft']);
  });

  it('⌥⌫ → Ctrl+Backspace', () => {
    const s = new Session('macOS', ON);
    expect(
      s.runAll([
        down('AltLeft', { alt: true }, 0),
        down('Backspace', { alt: true }, 10),
        up('Backspace', { alt: true }, 100),
        up('AltLeft', {}, 200)
      ])
    ).toEqual(['+AltLeft', '+ControlLeft', '-AltLeft', '+Backspace', '-Backspace', '-ControlLeft']);
  });
});

describe('active: cmdArrows and cmdTabSwitch', () => {
  it('⌘← → Home with Ctrl released during the tap and lazily re-pressed before the next key', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('MetaLeft', { meta: true }, 0))).toEqual(['+ControlLeft']);
    expect(s.run(down('ArrowLeft', { meta: true }, 10))).toEqual([
      '-ControlLeft',
      '+Home',
      '~ArrowLeft@50'
    ]);
    expect(s.run(timer('ArrowLeft', 60))).toEqual(['-Home']);
    expect(s.state.deferred.has('ctrl')).toBe(true);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.run(down('KeyC', { meta: true }, 100))).toEqual(['+ControlLeft', '+KeyC', '~KeyC@50']);
    expect(s.run(timer('KeyC', 150))).toEqual(['-KeyC']);
    expect(s.run(up('MetaLeft', {}, 200))).toEqual(['-ControlLeft']);
    expect(s.state.keys.size).toBe(0);
  });

  it('a physical ⌃ press while Ctrl is deferred re-presses it at once (⌘-click = Ctrl+click)', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ArrowLeft', { meta: true }, 10),
      timer('ArrowLeft', 60)
    ]);
    expect(s.state.deferred.has('ctrl')).toBe(true);
    expect(s.state.wireMods.size).toBe(0);

    expect(s.run(down('ControlLeft', { meta: true, ctrl: true }, 100))).toEqual(['+ControlLeft']);
    expect(s.state.deferred.size).toBe(0);
    // ⌘ is still held: its Ctrl stays on the wire when the physical ⌃ goes up
    expect(s.run(up('ControlLeft', { meta: true }, 200))).toEqual([]);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft']));
    expect(s.run(up('MetaLeft', {}, 300))).toEqual(['-ControlLeft']);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('a second ⌘ pressed while its Ctrl is deferred brings Ctrl back as well', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ArrowLeft', { meta: true }, 10),
      timer('ArrowLeft', 60)
    ]);
    expect(s.run(down('MetaRight', { meta: true }, 100))).toEqual([
      '+ControlLeft',
      '+ControlRight'
    ]);
    expect(s.run(up('MetaRight', { meta: true }, 200))).toEqual(['-ControlRight']);
    expect(s.run(up('MetaLeft', {}, 300))).toEqual(['-ControlLeft']);
  });

  it('⌘← released by ⌘-up before its timer: no spurious Ctrl re-press', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('ArrowLeft', { meta: true }, 10)]);
    expect(s.run(up('MetaLeft', {}, 50))).toEqual(['-Home', 'xArrowLeft']);
    expect(s.state.wireMods.size).toBe(0);
    expect(s.state.deferred.size).toBe(0);
    expect(s.state.keys.size).toBe(0);
  });

  it('⌘⇧← keeps ShiftLeft on the wire (select to line start)', () => {
    const s = new Session('macOS', ON);
    s.run(down('MetaLeft', { meta: true }, 0));
    expect(s.run(down('ShiftLeft', { meta: true, shift: true }, 5))).toEqual(['+ShiftLeft']);
    expect(s.run(down('ArrowLeft', { meta: true, shift: true }, 10))).toEqual([
      '-ControlLeft',
      '+Home',
      '~ArrowLeft@50'
    ]);
    expect(s.state.wireMods).toEqual(new Set(['ShiftLeft']));
    expect(s.run(timer('ArrowLeft', 60))).toEqual(['-Home']);
    expect(s.run(up('ShiftLeft', { meta: true }, 100))).toEqual(['-ShiftLeft']);
    expect(s.run(up('MetaLeft', {}, 200))).toEqual([]);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('⌘↑ → Ctrl+Home with no Ctrl churn', () => {
    const s = new Session('macOS', ON);
    const all = s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ArrowUp', { meta: true }, 10),
      timer('ArrowUp', 60),
      up('MetaLeft', {}, 200)
    ]);
    expect(all).toEqual(['+ControlLeft', '+Home', '~ArrowUp@50', '-Home', '-ControlLeft']);
  });

  it('⌘⇧] releases ShiftLeft before Tab (Ctrl+Tab); ⌘⇧[ keeps it (Ctrl+Shift+Tab)', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5)
    ]);
    expect(s.run(down('BracketRight', { meta: true, shift: true }, 10))).toEqual([
      '-ShiftLeft',
      '+Tab',
      '~BracketRight@50'
    ]);
    expect(s.run(timer('BracketRight', 60))).toEqual(['-Tab']);
    expect(s.state.deferred.has('shift')).toBe(true);
    expect(s.run(down('BracketLeft', { meta: true, shift: true }, 100))).toEqual([
      '+ShiftLeft',
      '+Tab',
      '~BracketLeft@50'
    ]);
    expect(s.run(timer('BracketLeft', 150))).toEqual(['-Tab']);
    expect(s.run(up('ShiftLeft', { meta: true }, 200))).toEqual(['-ShiftLeft']);
    expect(s.run(up('MetaLeft', {}, 300))).toEqual(['-ControlLeft']);
  });

  it('JIS host: ⌘⇧ on the keys printed [ / ] (codes BracketRight / Backslash) switch tabs', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5)
    ]);
    const chord = { ...NO_MODS, meta: true, shift: true };
    const prev = makeKeyEvent({ code: 'BracketRight', key: '[', mods: chord, timeStamp: 10 });
    expect(s.run(prev)).toEqual(['+Tab', '~BracketRight@50']);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft', 'ShiftLeft']));
    expect(s.run(timer('BracketRight', 60))).toEqual(['-Tab']);

    const next = makeKeyEvent({ code: 'Backslash', key: '}', mods: chord, timeStamp: 100 });
    expect(s.run(next)).toEqual(['-ShiftLeft', '+Tab', '~Backslash@50']);
    expect(s.run(timer('Backslash', 150))).toEqual(['-Tab']);
    expect(s.run(up('ShiftLeft', { meta: true }, 200))).toEqual([]);
    expect(s.run(up('MetaLeft', {}, 300))).toEqual(['-ControlLeft']);
  });

  it('⌘⌥→ → Ctrl+Tab and ⌘⌥← → Ctrl+Shift+Tab with Alt masked', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('AltLeft', { meta: true, alt: true }, 5)]);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft', 'AltLeft']));
    expect(s.run(down('ArrowRight', { meta: true, alt: true }, 10))).toEqual([
      '-AltLeft',
      '+Tab',
      '~ArrowRight@50'
    ]);
    expect(s.run(timer('ArrowRight', 60))).toEqual(['-Tab']);
    expect(s.run(down('ArrowLeft', { meta: true, alt: true }, 100))).toEqual([
      '+ShiftLeft',
      '+Tab',
      '~ArrowLeft@50'
    ]);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft', 'ShiftLeft']));
    expect(s.run(timer('ArrowLeft', 150))).toEqual(['-Tab', '-ShiftLeft']);
    expect(s.run(up('AltLeft', { meta: true }, 200))).toEqual([]);
    expect(s.run(up('MetaLeft', {}, 300))).toEqual(['-ControlLeft']);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('⌘← then ⌘↑ within one tap window finishes the first Home before pressing Home again', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('ArrowLeft', { meta: true }, 10)]);
    expect(s.run(down('ArrowUp', { meta: true }, 30))).toEqual([
      '-Home',
      'xArrowLeft',
      '+ControlLeft',
      '+Home',
      '~ArrowUp@50'
    ]);
    expect(s.run(timer('ArrowLeft', 60))).toEqual([]);
    expect(s.run(timer('ArrowUp', 80))).toEqual(['-Home']);
  });

  it('a held key colliding on the same out code is finished first', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('Home', {}, 0))).toEqual(['+Home']);
    s.run(down('MetaLeft', { meta: true }, 10));
    expect(s.run(down('ArrowLeft', { meta: true }, 20))).toEqual([
      '-Home',
      '-ControlLeft',
      '+Home',
      '~ArrowLeft@50'
    ]);
    expect(s.run(up('Home', { meta: true }, 30))).toEqual([]);
  });
});

describe('active: minPressMs on the ⌘-up sweep', () => {
  it('⌘ released 5 ms after KeyC keeps Ctrl+C until the timer fires, then key, then Ctrl', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 100)]);
    expect(s.run(up('MetaLeft', {}, 105))).toEqual([]);
    expect(s.state.sweepPending).toBe(true);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft']));
    expect(s.run(timer('KeyC', 150))).toEqual(['-KeyC', '-ControlLeft']);
    expect(s.state.sweepPending).toBe(false);
    expect(s.state.keys.size).toBe(0);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('a keydown during sweepPending flushes the sweep first', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('KeyC', { meta: true }, 100),
      up('MetaLeft', {}, 105)
    ]);
    expect(s.run(down('KeyA', {}, 110))).toEqual(['-KeyC', 'xKeyC', '-ControlLeft', '+KeyA']);
    expect(s.state.sweepPending).toBe(false);
  });

  it('⌘ pressed again during sweepPending keeps Ctrl down without churn', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('KeyC', { meta: true }, 100),
      up('MetaLeft', {}, 105)
    ]);
    expect(s.run(down('MetaLeft', { meta: true }, 110))).toEqual(['-KeyC', 'xKeyC']);
    expect(s.state.wireMods).toEqual(new Set(['ControlLeft']));
    expect(s.run(down('KeyV', { meta: true }, 120))).toEqual(['+KeyV', '~KeyV@50']);
  });

  it('a real keyup of the young tap during sweepPending is left to its timer', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('KeyC', { meta: true }, 100),
      up('MetaLeft', {}, 105)
    ]);
    expect(s.run(up('KeyC', {}, 110))).toEqual([]);
    expect(s.run(timer('KeyC', 150))).toEqual(['-KeyC', '-ControlLeft']);
  });

  it('an old tap is swept immediately; minPressMs=0 disables the deferral', () => {
    const s = new Session('macOS', ON);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 100)]);
    expect(s.run(up('MetaLeft', {}, 130))).toEqual(['-KeyC', 'xKeyC', '-ControlLeft']);

    const z = new Session('macOS', ctxOf(true, { minPressMs: 0 }));
    z.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 100)]);
    expect(z.run(up('MetaLeft', {}, 101))).toEqual(['-KeyC', 'xKeyC', '-ControlLeft']);
  });
});

describe('jisEisuKana and CapsLock', () => {
  it('jisEisuKana on: 英数/かな → NonConvert/Convert (held); off: pass-through', () => {
    const on = new Session('macOS', ctxOf(true, { jisEisuKana: true }));
    expect(on.runAll([down('Lang2'), up('Lang2'), down('Lang1'), up('Lang1')])).toEqual([
      '+NonConvert',
      '-NonConvert',
      '+Convert',
      '-Convert'
    ]);
    const off = new Session('macOS', ON);
    expect(off.runAll([down('Lang2'), up('Lang2')])).toEqual(['+Lang2', '-Lang2']);
  });

  it('CapsLock fix on macOS when active: keydown and keyup both tap', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('CapsLock', {}, 0))).toEqual(['+CapsLock', '~CapsLock@50']);
    expect(s.run(timer('CapsLock', 50))).toEqual(['-CapsLock']);
    expect(s.run(up('CapsLock', {}, 1000))).toEqual(['+CapsLock', '~CapsLock@50']);
    expect(s.run(timer('CapsLock', 1050))).toEqual(['-CapsLock']);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('CapsLock keyup before the keydown tap finished: first tap closed, second tap started', () => {
    const s = new Session('macOS', ON);
    s.run(down('CapsLock', {}, 0));
    expect(s.run(up('CapsLock', {}, 20))).toEqual([
      '-CapsLock',
      'xCapsLock',
      '+CapsLock',
      '~CapsLock@50'
    ]);
  });

  it('CapsLock fix is off when inactive, when disabled, or on a Windows host', () => {
    expect(new Session('macOS', OFF).runAll([down('CapsLock'), up('CapsLock')])).toEqual([
      '+CapsLock',
      '-CapsLock'
    ]);
    expect(
      new Session('macOS', ctxOf(true, { macCapsLockFix: false })).runAll([
        down('CapsLock'),
        up('CapsLock')
      ])
    ).toEqual(['+CapsLock', '-CapsLock']);
    expect(new Session('Windows', ctxOf(true)).runAll([down('CapsLock'), up('CapsLock')])).toEqual([
      '+CapsLock',
      '-CapsLock'
    ]);
  });
});

describe('host actions', () => {
  const paste: HostAction = {
    id: 'paste-host-clipboard',
    chord: { code: 'KeyV', meta: true, shift: true },
    enabled: true
  };

  it('⌘⇧V is consumed: host-action emitted, no press, repeats swallowed, keyup silent', () => {
    const s = new Session('macOS', ctxOf(true, {}, [paste]));
    expect(s.run(down('MetaLeft', { meta: true }, 0))).toEqual(['+ControlLeft']);
    expect(s.run(down('ShiftLeft', { meta: true, shift: true }, 5))).toEqual(['+ShiftLeft']);
    expect(s.run(down('KeyV', { meta: true, shift: true }, 10))).toEqual([
      'host:paste-host-clipboard'
    ]);
    expect(s.state.keys.get('KeyV')?.kind).toBe('consumed');
    expect(s.run(down('KeyV', { meta: true, shift: true }, 500, true))).toEqual([]);
    expect(s.run(up('KeyV', { meta: true, shift: true }, 600))).toEqual([]);
    expect(s.state.keys.has('KeyV')).toBe(false);
    expect(s.run(up('ShiftLeft', { meta: true }, 700))).toEqual(['-ShiftLeft']);
    expect(s.run(up('MetaLeft', {}, 800))).toEqual(['-ControlLeft']);
  });

  it('the consumed entry survives the ⌘-up sweep and a plain repeat after ⌘ is up', () => {
    const s = new Session('macOS', ctxOf(true, {}, [paste]));
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5),
      down('KeyV', { meta: true, shift: true }, 10),
      up('ShiftLeft', { meta: true }, 20)
    ]);
    expect(s.run(up('MetaLeft', {}, 30))).toEqual(['-ControlLeft']);
    expect(s.run(down('KeyV', {}, 100, true))).toEqual([]);
    expect(s.run(up('KeyV', {}, 200))).toEqual([]);
  });

  it('V released under ⌘ (no keyup, A1): the stale consumed entry does not swallow the next plain v', () => {
    const s = new Session('macOS', ctxOf(true, {}, [paste]));
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5),
      down('KeyV', { meta: true, shift: true }, 10),
      up('ShiftLeft', { meta: true }, 20)
    ]);
    expect(s.run(up('MetaLeft', {}, 30))).toEqual(['-ControlLeft']);
    expect(s.state.keys.get('KeyV')?.kind).toBe('consumed');

    expect(s.run(down('KeyV', {}, 1000))).toEqual(['+KeyV']);
    expect(s.state.keys.get('KeyV')?.kind).toBe('key');
    expect(s.run(down('KeyV', {}, 1030, true))).toEqual([]);
    expect(s.run(up('KeyV', {}, 1100))).toEqual(['-KeyV']);
    expect(s.state.keys.size).toBe(0);
  });

  it('a stale consumed entry is also dropped by a fresh ⌘V tap and once the remap is inactive', () => {
    const tap = new Session('macOS', ctxOf(true, {}, [paste]));
    tap.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5),
      down('KeyV', { meta: true, shift: true }, 10),
      up('ShiftLeft', { meta: true }, 20)
    ]);
    expect(tap.run(down('KeyV', { meta: true }, 500))).toEqual(['+KeyV', '~KeyV@50']);

    const s = new Session('macOS', ctxOf(true, {}, [paste]));
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5),
      down('KeyV', { meta: true, shift: true }, 10),
      up('ShiftLeft', { meta: true }, 20),
      up('MetaLeft', {}, 30)
    ]);
    s.ctx = ctxOf(false, {}, [paste]);
    expect(s.run(down('KeyV', {}, 1000))).toEqual(['+KeyV']);
    expect(s.run(up('KeyV', {}, 1100))).toEqual(['-KeyV']);
  });

  it('a fresh physical re-press of the chord triggers the action again', () => {
    const s = new Session('macOS', ctxOf(true, {}, [paste]));
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5),
      down('KeyV', { meta: true, shift: true }, 10)
    ]);
    expect(s.run(down('KeyV', { meta: true, shift: true }, 300))).toEqual([
      'host:paste-host-clipboard'
    ]);
  });

  it('chord not matched when inactive or disabled: KeyV is forwarded', () => {
    const inactive = new Session('macOS', ctxOf(false, {}, [paste]));
    inactive.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5)
    ]);
    expect(inactive.run(down('KeyV', { meta: true, shift: true }, 10))).toEqual(['+KeyV']);

    const disabled = new Session('macOS', ctxOf(true, {}, [{ ...paste, enabled: false }]));
    disabled.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5)
    ]);
    expect(disabled.run(down('KeyV', { meta: true, shift: true }, 10))).toEqual([
      '+KeyV',
      '~KeyV@50'
    ]);
  });
});

describe('misc', () => {
  it('an unknown out code (Fn) yields no actions besides the trace', () => {
    const s = new Session('macOS', ON);
    expect(s.run(down('Fn'))).toEqual([]);
    expect(s.run(up('Fn'))).toEqual([]);
    expect(s.state.keys.size).toBe(0);
  });

  it('every keydown/keyup/timer ends with exactly one trace carrying the sent codes', () => {
    const s = new Session('macOS', ON);
    const events = [
      down('MetaLeft', { meta: true }, 0),
      down('KeyC', { meta: true }, 10),
      down('KeyC', { meta: true }, 20, true),
      timer('KeyC', 60),
      timer('Nope', 61),
      up('MetaLeft', {}, 100),
      up('KeyX', {}, 110)
    ];
    const sent: string[][] = [];
    for (const ev of events) {
      const actions = s.raw(ev);
      const traces = actions.filter((a) => a.type === 'trace');
      expect(traces).toHaveLength(1);
      expect(actions[actions.length - 1]).toBe(traces[0]);
      const trace = traces[0];
      if (trace.type !== 'trace') throw new Error('unreachable');
      expect(trace.ev).toBe(ev);
      sent.push(trace.sent);
    }
    expect(sent).toEqual([['+ControlLeft'], ['+KeyC'], [], ['-KeyC'], [], ['-ControlLeft'], []]);
    expect(s.raw(RELEASE_ALL).some((a) => a.type === 'trace')).toBe(false);
  });

  it('key === "Process" emits an IME hint but the key is still forwarded', () => {
    const s = new Session('macOS', ON);
    const ev = makeKeyEvent({ code: 'KeyA', key: 'Process' });
    expect(s.run(ev)).toEqual(['hint:ime-composing', '+KeyA']);
  });

  it('a timer for a key that is held (no tap) or unknown is a no-op', () => {
    const s = new Session('macOS', ON);
    s.run(down('KeyA'));
    expect(s.run(timer('KeyA', 50))).toEqual([]);
    expect(s.run(timer('KeyZ', 50))).toEqual([]);
    expect(s.run(up('KeyA'))).toEqual(['-KeyA']);
  });

  it('a keydown with no HID keycode under ⌘ does not clear the deferred set', () => {
    const s = new Session('macOS', ON);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ArrowLeft', { meta: true }, 10),
      timer('ArrowLeft', 60)
    ]);
    expect(s.state.deferred.has('ctrl')).toBe(true);
    expect(s.run(down('Fn', { meta: true }, 70))).toEqual([]);
    expect(s.state.deferred.has('ctrl')).toBe(true);
  });
});

describe('active: ⌘ split (listed keys → Ctrl, others → Win)', () => {
  const SPLIT = ctxOf(true, { cmdSplit: true, ctrlKeys: 'ACFVXZ' });

  it('⌘ down sends nothing; ⌘C is Ctrl+C, then nothing held', () => {
    const s = new Session('macOS', SPLIT);
    expect(s.run(down('MetaLeft', { meta: true }, 0))).toEqual([]);
    expect(s.run(down('KeyC', { meta: true }, 10))).toEqual(['+ControlLeft', '+KeyC', '~KeyC@50']);
    expect(s.run(timer('KeyC', 60))).toEqual(['-KeyC', '-ControlLeft']);
    expect(s.run(up('MetaLeft', {}, 500))).toEqual([]);
    expect(s.state.keys.size).toBe(0);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('⌘⇧S is Win+Shift+S (screenshot), no Win tap on ⌘ up', () => {
    const s = new Session('macOS', SPLIT);
    expect(
      s.runAll([
        down('MetaLeft', { meta: true }, 0),
        down('ShiftLeft', { meta: true, shift: true }, 5)
      ])
    ).toEqual(['+ShiftLeft']);
    expect(s.run(down('KeyS', { meta: true, shift: true }, 10))).toEqual([
      '+MetaLeft',
      '+KeyS',
      '~KeyS@50'
    ]);
    expect(s.run(timer('KeyS', 60))).toEqual(['-KeyS', '-MetaLeft']);
    expect(s.run(up('ShiftLeft', { meta: true }, 80))).toEqual(['-ShiftLeft']);
    expect(s.run(up('MetaLeft', {}, 90))).toEqual([]);
  });

  it('⌘⇧F keeps Shift and uses Ctrl (listed key)', () => {
    const s = new Session('macOS', SPLIT);
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5)
    ]);
    expect(s.run(down('KeyF', { meta: true, shift: true }, 10))).toEqual([
      '+ControlLeft',
      '+KeyF',
      '~KeyF@50'
    ]);
  });

  it('⌘ alone is a Win tap', () => {
    const s = new Session('macOS', SPLIT);
    s.run(down('MetaLeft', { meta: true }, 0));
    expect(s.run(up('MetaLeft', {}, 100))).toEqual(['+MetaLeft', '-MetaLeft']);
    expect(
      forkReports('macOS', SPLIT, [down('MetaLeft', { meta: true }, 0), up('MetaLeft', {}, 100)])
    ).toEqual([R(0x08), R(0)]);
  });

  it('switches between Ctrl and Win while ⌘ stays held (⌘C then ⌘R)', () => {
    const s = new Session('macOS', SPLIT);
    s.runAll([down('MetaLeft', { meta: true }, 0), down('KeyC', { meta: true }, 10)]);
    // R before C's tap ends: C goes up first, the modifiers swap (presses
    // before releases, as everywhere in reconcile), then R
    expect(s.run(down('KeyR', { meta: true }, 20))).toEqual([
      '-KeyC',
      'xKeyC',
      '+MetaLeft',
      '-ControlLeft',
      '+KeyR',
      '~KeyR@50'
    ]);
    expect(s.run(timer('KeyR', 70))).toEqual(['-KeyR', '-MetaLeft']);
    expect(s.run(up('MetaLeft', {}, 80))).toEqual([]);
    expect(s.state.wireMods.size).toBe(0);
  });

  it('honours a custom key list and digits', () => {
    const s = new Session('macOS', ctxOf(true, { cmdSplit: true, ctrlKeys: 'S1' }));
    s.run(down('MetaLeft', { meta: true }, 0));
    expect(s.run(down('KeyS', { meta: true }, 10))[0]).toBe('+ControlLeft');
    s.run(timer('KeyS', 60));
    expect(s.run(down('Digit1', { meta: true }, 70))[0]).toBe('+ControlLeft');
    s.run(timer('Digit1', 120));
    expect(s.run(down('KeyC', { meta: true }, 130))[0]).toBe('+MetaLeft');
  });

  it('cmdArrows still win over the split (⌘← = Home)', () => {
    const s = new Session('macOS', SPLIT);
    s.run(down('MetaLeft', { meta: true }, 0));
    expect(s.run(down('ArrowLeft', { meta: true }, 10))).toEqual(['+Home', '~ArrowLeft@50']);
  });

  it('host action ⌘⇧V still fires and suppresses the Win tap', () => {
    const s = new Session(
      'macOS',
      ctxOf(true, { cmdSplit: true }, [
        {
          id: 'paste-host-clipboard',
          chord: { code: 'KeyV', meta: true, shift: true },
          enabled: true
        }
      ])
    );
    s.runAll([
      down('MetaLeft', { meta: true }, 0),
      down('ShiftLeft', { meta: true, shift: true }, 5)
    ]);
    expect(s.run(down('KeyV', { meta: true, shift: true }, 10))).toContain(
      'host:paste-host-clipboard'
    );
    s.run(up('ShiftLeft', { meta: true }, 20));
    expect(s.run(up('MetaLeft', {}, 30))).toEqual([]);
  });

  it('inactive (Windows host) never splits', () => {
    const s = new Session('Windows', ctxOf(false, { cmdSplit: true }));
    expect(s.run(down('MetaLeft', { meta: true }, 0))).toEqual(['+MetaLeft']);
  });
});

describe('invariants under arbitrary event streams', () => {
  const CODES = [
    'MetaLeft',
    'MetaRight',
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'AltLeft',
    'AltRight',
    'KeyC',
    'KeyV',
    'ArrowLeft',
    'ArrowUp',
    'BracketRight',
    'Backspace',
    'Home',
    'CapsLock',
    'Lang2',
    'Fn'
  ];

  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  function fuzz(hostOS: System, ctx: RemapContext, seed: number): void {
    const rnd = lcg(seed);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
    const state = createRemapState(hostOS);
    const pressed = new Set<string>();
    let t = 0;
    for (let i = 0; i < 1500; i++) {
      t += Math.floor(rnd() * 60);
      const roll = rnd();
      let ev: HostKeyEvent;
      if (roll < 0.02) {
        ev = RELEASE_ALL;
      } else if (roll < 0.25) {
        ev = timer(pick(CODES), t);
      } else {
        const mods: HostMods = {
          meta: rnd() < 0.5,
          ctrl: rnd() < 0.2,
          alt: rnd() < 0.2,
          shift: rnd() < 0.3
        };
        ev = rnd() < 0.55 ? down(pick(CODES), mods, t, rnd() < 0.3) : up(pick(CODES), mods, t);
      }
      const actions = translateKeyEvent(state, ev, ctx);
      for (const action of actions) {
        if (action.type === 'press') {
          expect(pressed.has(action.code), `double press ${action.code} at #${i}`).toBe(false);
          pressed.add(action.code);
        } else if (action.type === 'release') {
          expect(pressed.has(action.code), `release of unpressed ${action.code} at #${i}`).toBe(
            true
          );
          pressed.delete(action.code);
        } else if (action.type === 'reset') {
          pressed.clear();
        }
      }
      for (const code of state.wireMods) {
        expect(pressed.has(code), `wireMods ${code} not pressed at #${i}`).toBe(true);
      }
      for (const code of pressed) {
        if (isModifier(code)) {
          expect(
            state.wireMods.has(code),
            `pressed modifier ${code} not in wireMods at #${i}`
          ).toBe(true);
        }
      }
      for (const [, entry] of state.keys) {
        if (entry.kind === 'key' && !entry.released) {
          expect(pressed.has(entry.out), `unreleased entry ${entry.out} not pressed at #${i}`).toBe(
            true
          );
        }
      }
      if (ev.type === 'release-all') {
        expect(state.wireMods.size).toBe(0);
        expect(state.keys.size).toBe(0);
        expect(pressed.size).toBe(0);
      }
    }
    translateKeyEvent(state, RELEASE_ALL, ctx);
    expect(state.wireMods.size).toBe(0);
  }

  it.each([
    ['macOS', true, 1],
    ['macOS', true, 2],
    ['macOS', true, 3],
    ['macOS', false, 4],
    ['Windows', false, 5],
    ['Linux', false, 6]
  ] as const)(
    '%s active=%s seed=%s: never releases a code not on the wire',
    (hostOS, active, seed) => {
      fuzz(hostOS, ctxOf(active, { jisEisuKana: true }), seed);
    }
  );

  it.each([11, 12, 13])('holds in ⌘ split mode (seed %s)', (seed) => {
    fuzz('macOS', ctxOf(true, { cmdSplit: true, ctrlKeys: 'C', jisEisuKana: true }), seed);
  });

  it('holds with minPressMs=0 and repeatUnderMeta=false as well', () => {
    fuzz('macOS', ctxOf(true, { minPressMs: 0, repeatUnderMeta: false }), 7);
  });
});
