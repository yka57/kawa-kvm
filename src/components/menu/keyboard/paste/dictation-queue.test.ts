import { describe, expect, it } from 'vitest';

import { DictationQueue } from './dictation-queue';

describe('DictationQueue', () => {
  it('hands chunks out in order, one at a time, never while a run is busy', () => {
    const q = new DictationQueue();
    q.push('一つ目');
    q.push('二つ目');
    expect(q.size).toBe(2);
    expect(q.take(true)).toBeNull();
    expect(q.size).toBe(2);
    expect(q.take(false)).toBe('一つ目');
    expect(q.take(false)).toBe('二つ目');
    expect(q.take(false)).toBeNull();
  });

  it('ignores empty chunks and drains the unsent rest in order', () => {
    const q = new DictationQueue();
    q.push('');
    expect(q.size).toBe(0);
    q.push('a');
    q.push('b');
    expect(q.drain()).toBe('ab');
    expect(q.size).toBe(0);
    expect(q.drain()).toBe('');
  });
});
