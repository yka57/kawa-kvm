import { describe, expect, it } from 'vitest';

import { FakeClock, FakeSink, flushMicrotasks, makeKeyEvent, NO_MODS } from '@/test/fakes';

import { KeyboardDriver, type TraceEntry } from './driver';
import type { HostKeyEvent, HostMods } from './remap';
import {
  DEFAULT_REMAP_CONFIG,
  type HostAction,
  type KeyboardRemapConfig,
  type RemapContext
} from './remap-config';

const R = (modifier: number, ...keys: number[]): number[] => {
  const report = [modifier, 0, 0, 0, 0, 0, 0, 0];
  keys.forEach((key, i) => {
    report[2 + i] = key;
  });
  return report;
};

interface Harness {
  clock: FakeClock;
  sink: FakeSink;
  driver: KeyboardDriver;
  traces: TraceEntry[];
  hostActions: string[];
  hints: string[];
  errors: unknown[];
  down(code: string, mods?: Partial<HostMods>, repeat?: boolean): void;
  up(code: string, mods?: Partial<HostMods>): void;
}

function makeHarness(
  opts: {
    active?: boolean;
    cfg?: Partial<KeyboardRemapConfig>;
    hostActions?: HostAction[];
    onHostAction?: (id: string) => void;
  } = {}
): Harness {
  const clock = new FakeClock();
  const sink = new FakeSink();
  const traces: TraceEntry[] = [];
  const hostActions: string[] = [];
  const hints: string[] = [];
  const errors: unknown[] = [];
  const context: RemapContext = {
    cfg: { ...DEFAULT_REMAP_CONFIG, ...opts.cfg },
    active: opts.active ?? true,
    hostActions: opts.hostActions ?? []
  };
  const driver = new KeyboardDriver({
    send: sink.send,
    hostOS: 'macOS',
    clock,
    getContext: () => context,
    onTrace: (t) => traces.push(t),
    onHostAction:
      opts.onHostAction ??
      ((id) => {
        hostActions.push(id);
      }),
    onHint: (id) => hints.push(id),
    onError: (error) => errors.push(error)
  });
  const dispatch = (ev: HostKeyEvent): void => driver.dispatch(ev);
  return {
    clock,
    sink,
    driver,
    traces,
    hostActions,
    hints,
    errors,
    down: (code, mods = {}, repeat = false) =>
      dispatch(
        makeKeyEvent({ code, mods: { ...NO_MODS, ...mods }, timeStamp: clock.now(), repeat })
      ),
    up: (code, mods = {}) =>
      dispatch(
        makeKeyEvent({ type: 'keyup', code, mods: { ...NO_MODS, ...mods }, timeStamp: clock.now() })
      )
  };
}

describe('KeyboardDriver', () => {
  it('sends the tap release exactly tapReleaseMs after the press', async () => {
    const h = makeHarness();
    h.down('MetaLeft', { meta: true });
    h.down('KeyC', { meta: true });
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06)]);
    expect(h.clock.pendingTimers()).toBe(1);

    await h.clock.advanceAsync(49);
    expect(h.sink.reports).toHaveLength(2);

    await h.clock.advanceAsync(1);
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06), R(0x01)]);
    expect(h.clock.pendingTimers()).toBe(0);
    const timerTrace = h.traces[h.traces.length - 1];
    expect(timerTrace.ev).toEqual({ type: 'timer', code: 'KeyC', timeStamp: 50 });
    expect(timerTrace.sent).toEqual(['-KeyC']);
    expect(timerTrace.report).toEqual(R(0x01));

    h.up('MetaLeft');
    await h.driver.whenIdle();
    expect(h.sink.reports[3]).toEqual(R(0));
    expect(h.driver.lastReport()).toEqual(R(0));
  });

  it('cancels the tap timer when the ⌘-up sweep releases the key', async () => {
    const h = makeHarness();
    h.down('MetaLeft', { meta: true });
    h.down('KeyC', { meta: true });
    h.clock.advance(40);
    h.up('MetaLeft');
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06), R(0x01), R(0)]);
    expect(h.clock.pendingTimers()).toBe(0);

    await h.clock.advanceAsync(200);
    expect(h.sink.reports).toHaveLength(4);
  });

  it('honours minPressMs: the deferred sweep sends key-up then Ctrl-up from the timer', async () => {
    const h = makeHarness();
    h.down('MetaLeft', { meta: true });
    h.clock.advance(100);
    h.down('KeyC', { meta: true });
    h.clock.advance(5);
    h.up('MetaLeft');
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06)]);

    await h.clock.advanceAsync(45);
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06), R(0x01), R(0)]);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it('dry-run: state machine and traces run, nothing is sent; toggling releases all keys', async () => {
    const h = makeHarness();
    h.driver.setDryRun(true);
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0)]);
    expect(h.driver.isDryRun()).toBe(true);

    h.down('MetaLeft', { meta: true });
    h.down('KeyC', { meta: true });
    await h.clock.advanceAsync(60);
    expect(h.sink.reports).toHaveLength(1);
    expect(h.traces.map((t) => t.sent)).toEqual([['+ControlLeft'], ['+KeyC'], ['-KeyC']]);
    expect(h.driver.lastReport()).toEqual(R(0x01));

    h.driver.setDryRun(true);
    h.driver.setDryRun(false);
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0), R(0)]);
    expect(h.driver.isDryRun()).toBe(false);
    expect(h.driver.lastReport()).toEqual(R(0));

    h.down('KeyA');
    await h.driver.whenIdle();
    expect(h.sink.reports[2]).toEqual(R(0, 0x04));
  });

  it('muted: modifiers stay tracked, nothing is sent, unmute sends the current report once', async () => {
    const h = makeHarness();
    h.down('MetaLeft', { meta: true });
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01)]);

    h.driver.setMuted(true);
    h.driver.setMuted(true);
    expect(h.driver.isMuted()).toBe(true);
    h.down('ShiftLeft', { meta: true, shift: true });
    h.down('KeyA', { meta: true, shift: true });
    await h.clock.advanceAsync(60);
    expect(h.sink.reports).toHaveLength(1);
    expect(h.driver.lastReport()).toEqual(R(0x03));

    h.driver.setMuted(false);
    h.driver.setMuted(false);
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01), R(0x03)]);

    h.up('ShiftLeft', { meta: true });
    h.up('MetaLeft');
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01), R(0x03), R(0x01), R(0)]);
  });

  it('keeps sends in action order even when the sink is slow', async () => {
    const h = makeHarness();
    h.sink.hangAt = 1;
    h.down('MetaLeft', { meta: true });
    h.down('KeyC', { meta: true });
    await flushMicrotasks();
    expect(h.sink.reports).toEqual([R(0x01)]);

    await h.clock.advanceAsync(50);
    expect(h.sink.reports).toEqual([R(0x01)]);

    h.up('MetaLeft');
    await flushMicrotasks();
    h.sink.releaseHung();
    await h.driver.whenIdle();
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06), R(0x01), R(0)]);
  });

  it('reports a send failure once per streak and keeps working', async () => {
    const h = makeHarness();
    h.sink.rejectAt = 1;
    h.down('KeyA');
    h.up('KeyA');
    h.down('KeyB');
    await h.driver.whenIdle();
    expect(h.errors).toHaveLength(1);
    expect(h.sink.reports).toEqual([R(0, 0x04), R(0), R(0, 0x05)]);
    h.up('KeyB');
    await h.driver.whenIdle();
    expect(h.errors).toHaveLength(1);
    expect(h.sink.reports).toHaveLength(4);
  });

  it('releaseAll cancels timers, sends one all-zero report and forgets everything', async () => {
    const h = makeHarness();
    h.down('MetaLeft', { meta: true });
    h.down('KeyC', { meta: true });
    h.driver.releaseAll();
    await h.driver.whenIdle();
    expect(h.clock.pendingTimers()).toBe(0);
    expect(h.sink.reports).toEqual([R(0x01), R(0x01, 0x06), R(0)]);
    expect(h.driver.lastReport()).toEqual(R(0));

    h.up('MetaLeft');
    await h.driver.whenIdle();
    expect(h.sink.reports).toHaveLength(3);
  });

  it('forwards host actions and hints; a throwing listener does not break dispatch', async () => {
    const paste: HostAction = {
      id: 'paste-host-clipboard',
      chord: { code: 'KeyV', meta: true, shift: true },
      enabled: true
    };
    const h = makeHarness({ hostActions: [paste] });
    h.down('MetaLeft', { meta: true });
    h.down('ShiftLeft', { meta: true, shift: true });
    h.down('KeyV', { meta: true, shift: true });
    await h.driver.whenIdle();
    expect(h.hostActions).toEqual(['paste-host-clipboard']);
    expect(h.sink.reports).toEqual([R(0x01), R(0x03)]);

    h.driver.dispatch(makeKeyEvent({ code: 'KeyA', key: 'Process', mods: { ...NO_MODS } }));
    expect(h.hints).toEqual(['ime-composing']);

    const throwing = makeHarness({
      hostActions: [paste],
      onHostAction: () => {
        throw new Error('listener failed');
      }
    });
    throwing.down('MetaLeft', { meta: true });
    throwing.down('ShiftLeft', { meta: true, shift: true });
    expect(() => throwing.down('KeyV', { meta: true, shift: true })).not.toThrow();
    expect(throwing.errors).toHaveLength(1);
  });

  it('types a plain v after ⌘⇧V whose V keyup never arrived (released under ⌘)', async () => {
    const paste: HostAction = {
      id: 'paste-host-clipboard',
      chord: { code: 'KeyV', meta: true, shift: true },
      enabled: true
    };
    const h = makeHarness({ hostActions: [paste] });
    h.down('MetaLeft', { meta: true });
    h.down('ShiftLeft', { meta: true, shift: true });
    h.down('KeyV', { meta: true, shift: true });
    h.up('ShiftLeft', { meta: true });
    h.up('MetaLeft');
    await h.driver.whenIdle();
    expect(h.hostActions).toEqual(['paste-host-clipboard']);
    expect(h.sink.reports).toEqual([R(0x01), R(0x03), R(0x01), R(0)]);

    h.down('KeyV');
    h.up('KeyV');
    await h.driver.whenIdle();
    expect(h.sink.reports.slice(4)).toEqual([R(0, 0x19), R(0)]);
    expect(h.driver.report.getPressedKeyCount()).toBe(0);
  });

  it('works with the default (real) clock when none is injected', async () => {
    const sink = new FakeSink();
    const driver = new KeyboardDriver({
      send: sink.send,
      hostOS: 'macOS',
      getContext: () => ({ cfg: DEFAULT_REMAP_CONFIG, active: false, hostActions: [] })
    });
    driver.dispatch(makeKeyEvent({ code: 'KeyA' }));
    driver.dispatch(makeKeyEvent({ type: 'keyup', code: 'KeyA' }));
    await driver.whenIdle();
    expect(sink.reports).toEqual([R(0, 0x04), R(0)]);
    expect(driver.report.getPressedKeyCount()).toBe(0);
  });
});
