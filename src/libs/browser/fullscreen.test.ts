import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushMicrotasks } from '@/test/fakes';

type Listener = () => void;

function makeDocument(fullscreen: boolean) {
  const listeners = new Map<string, Listener[]>();
  return {
    fullscreenElement: fullscreen ? ({} as Element) : null,
    documentElement: { requestFullscreen: vi.fn(() => Promise.resolve()) },
    exitFullscreen: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn((type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    }),
    fire(type: string) {
      (listeners.get(type) ?? []).forEach((fn) => fn());
    }
  };
}

function makeKeyboard() {
  return { lock: vi.fn(() => Promise.resolve()), unlock: vi.fn() };
}

async function load() {
  return import('./fullscreen');
}

describe('toggleFullscreenWithKeyboardLock', () => {
  beforeEach(() => {
    // the module keeps "listener installed" state; start fresh every time
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('enters fullscreen first and then locks the keyboard', async () => {
    const doc = makeDocument(false);
    const keyboard = makeKeyboard();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { keyboard });
    const { toggleFullscreenWithKeyboardLock } = await load();

    toggleFullscreenWithKeyboardLock();

    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(keyboard.lock).toHaveBeenCalledTimes(1);
    expect(keyboard.unlock).not.toHaveBeenCalled();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
    expect(keyboard.lock.mock.invocationCallOrder[0]).toBeGreaterThan(
      doc.documentElement.requestFullscreen.mock.invocationCallOrder[0]
    );
  });

  it('leaves fullscreen and unlocks when already fullscreen', async () => {
    const doc = makeDocument(true);
    const keyboard = makeKeyboard();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { keyboard });
    const { toggleFullscreenWithKeyboardLock, isFullscreen } = await load();

    expect(isFullscreen()).toBe(true);
    toggleFullscreenWithKeyboardLock();

    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
    expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
    expect(keyboard.lock).not.toHaveBeenCalled();
  });

  it('unlocks when fullscreen ends by other means (Esc), with one listener for all toggles', async () => {
    const doc = makeDocument(false);
    const keyboard = makeKeyboard();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { keyboard });
    const { toggleFullscreenWithKeyboardLock } = await load();

    toggleFullscreenWithKeyboardLock();
    doc.fullscreenElement = {} as Element;
    // still fullscreen: nothing to unlock
    doc.fire('fullscreenchange');
    expect(keyboard.unlock).not.toHaveBeenCalled();

    // user pressed Esc: fullscreen gone → unlock
    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);

    toggleFullscreenWithKeyboardLock();
    expect(doc.addEventListener).toHaveBeenCalledTimes(1);
    expect(doc.addEventListener).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
  });

  it('works in browsers without the Keyboard Lock API', async () => {
    const doc = makeDocument(false);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', {});
    const { toggleFullscreenWithKeyboardLock } = await load();

    expect(() => toggleFullscreenWithKeyboardLock()).not.toThrow();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);

    doc.fullscreenElement = null;
    expect(() => doc.fire('fullscreenchange')).not.toThrow();
  });

  it('logs instead of throwing when requestFullscreen or lock reject', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const doc = makeDocument(false);
    doc.documentElement.requestFullscreen = vi.fn(() => Promise.reject(new Error('denied')));
    const keyboard = {
      lock: vi.fn(() => Promise.reject(new Error('no permission'))),
      unlock: vi.fn()
    };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { keyboard });
    const { toggleFullscreenWithKeyboardLock } = await load();

    expect(() => toggleFullscreenWithKeyboardLock()).not.toThrow();
    await flushMicrotasks();

    expect(debug).toHaveBeenCalledTimes(2);
  });

  it('reports not fullscreen when there is no document (node)', async () => {
    const { isFullscreen } = await load();
    expect(isFullscreen()).toBe(false);
  });
});
