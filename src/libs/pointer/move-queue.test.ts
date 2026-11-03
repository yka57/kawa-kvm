import { describe, expect, it } from 'vitest';

import { FakeSink, flushMicrotasks } from '@/test/fakes';

import { MoveQueue } from './move-queue';

/** Absolute MOVE payload at x (y = 0), wheel 0. */
function abs(x: number, buttons = 0): number[] {
  return [0x02, buttons, x & 0xff, (x >> 8) & 0xff, 0, 0, 0];
}

function button(buttons: number): number[] {
  return [0x02, buttons, 0, 0, 0, 0, 0];
}

const WHEEL_DOWN = [0x02, 0, 0, 0, 0, 0, 0xff];

describe('MoveQueue', () => {
  it('hands a payload to send synchronously when idle', () => {
    const sink = new FakeSink();
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    expect(sink.reports).toEqual([abs(1)]);
    expect(queue.stats()).toMatchObject({ enqueued: 1, merged: 0, pending: 0, busy: true });
  });

  it('absolute moves behind a hung write collapse to the newest position (latest wins)', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    queue.moveAbsolute(abs(2));
    queue.moveAbsolute(abs(3));
    queue.moveAbsolute(abs(4));
    await flushMicrotasks();
    expect(sink.reports).toEqual([abs(1)]);
    expect(queue.stats()).toMatchObject({ enqueued: 4, merged: 2, pending: 1, busy: true });

    sink.releaseHung();
    await queue.flush();
    expect(sink.reports).toEqual([abs(1), abs(4)]);
    expect(queue.stats()).toMatchObject({ sent: 2, failed: 0, pending: 0, busy: false });
  });

  it('button and wheel reports are never dropped and a pending move is flushed first', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    queue.moveAbsolute(abs(2));
    const pressed = queue.send(button(1));
    queue.moveAbsolute(abs(3, 1));
    queue.moveAbsolute(abs(4, 1));
    const wheeled = queue.send(WHEEL_DOWN);
    const released = queue.send(button(0));

    sink.releaseHung();
    await Promise.all([pressed, wheeled, released]);
    await queue.flush();
    expect(sink.reports).toEqual([abs(1), abs(2), button(1), abs(4, 1), WHEEL_DOWN, button(0)]);
    expect(queue.stats()).toMatchObject({ enqueued: 7, merged: 1, sent: 6 });
  });

  it('relative moves sum while busy and are split into int8 chunks at send time', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveRelative(0, 5, 0);
    queue.moveRelative(0, 100, -30);
    queue.moveRelative(0, 200, -100);
    expect(queue.stats()).toMatchObject({ merged: 1, pending: 1 });

    sink.releaseHung();
    await queue.flush();
    expect(sink.reports).toEqual([
      [0x01, 0, 5, 0, 0],
      [0x01, 0, 127, 0x81, 0],
      [0x01, 0, 127, 0xfd, 0],
      [0x01, 0, 46, 0, 0]
    ]);
  });

  it('a relative sum that cancels out sends nothing', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveRelative(0, 5, 0);
    queue.moveRelative(0, 3, -2);
    queue.moveRelative(0, -3, 2);
    sink.releaseHung();
    await queue.flush();
    expect(sink.reports).toEqual([[0x01, 0, 5, 0, 0]]);
  });

  it('moves with a different buttons byte are kept apart (a button change is a barrier)', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveRelative(0, 5, 0);
    queue.moveRelative(0, 1, 0);
    queue.moveRelative(1, 1, 0);
    queue.moveAbsolute(abs(2, 0));
    queue.moveAbsolute(abs(3, 1));
    expect(queue.stats().pending).toBe(4);

    sink.releaseHung();
    await queue.flush();
    expect(sink.reports).toEqual([
      [0x01, 0, 5, 0, 0],
      [0x01, 0, 1, 0, 0],
      [0x01, 1, 1, 0, 0],
      abs(2, 0),
      abs(3, 1)
    ]);
  });

  it('moves of different kinds behind the same write do not merge into each other', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    queue.moveRelative(0, 2, 0);
    queue.moveAbsolute(abs(3));
    sink.releaseHung();
    await queue.flush();
    expect(sink.reports).toEqual([abs(1), [0x01, 0, 2, 0, 0], abs(3)]);
  });

  it('reports errors through onError, keeps going and still resolves send()', async () => {
    const sink = new FakeSink();
    sink.rejectAt = 2;
    const errors: unknown[] = [];
    const queue = new MoveQueue(sink.send, { onError: (error) => errors.push(error) });
    await queue.send(button(1));
    await queue.send(button(0));
    await queue.send(WHEEL_DOWN);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(sink.reports).toEqual([button(1), button(0), WHEEL_DOWN]);
    expect(queue.stats()).toMatchObject({ sent: 2, failed: 1, pending: 0, busy: false });
  });

  it('a failing write does not stall queued moves', async () => {
    const sink = new FakeSink();
    sink.rejectAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    queue.moveAbsolute(abs(2));
    await queue.flush();
    expect(sink.reports).toEqual([abs(1), abs(2)]);
  });

  it('flush() resolves immediately when idle and after the backlog otherwise', async () => {
    const sink = new FakeSink();
    const queue = new MoveQueue(sink.send);
    await queue.flush();

    sink.hangAt = 1;
    queue.moveAbsolute(abs(1));
    let flushed = false;
    void queue.flush().then(() => {
      flushed = true;
    });
    await flushMicrotasks();
    expect(flushed).toBe(false);
    sink.releaseHung();
    await flushMicrotasks();
    expect(flushed).toBe(true);
  });

  it('clear() drops queued items (not the in-flight write) and resolves their promises', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    queue.moveAbsolute(abs(2));
    let resolved = false;
    void queue.send(button(1)).then(() => {
      resolved = true;
    });
    queue.clear();
    await flushMicrotasks();
    expect(resolved).toBe(true);
    expect(queue.stats().pending).toBe(0);

    sink.releaseHung();
    await queue.flush();
    expect(sink.reports).toEqual([abs(1)]);
  });

  it('after draining, a new report goes out synchronously again', async () => {
    const sink = new FakeSink();
    const queue = new MoveQueue(sink.send);
    queue.moveAbsolute(abs(1));
    await queue.flush();
    queue.moveRelative(2, -7, 7);
    expect(sink.reports).toEqual([abs(1), [0x01, 2, 0xf9, 7, 0]]);
  });
});
