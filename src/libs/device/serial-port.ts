import { FrameParser, type ParsedFrame } from './frame-parser';
import { isDisconnectError, raceWithTimeout } from './utils';

type WebSerialPort = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};

type Options = {
  port: WebSerialPort;
  baudRate?: number;
  onDisconnect?: () => void;
};

export type FrameListener = (frame: ParsedFrame) => void;

export class SerialPort {
  readonly SERIAL_BAUD_RATE = 57600;
  readonly CLEANUP_TIMEOUT = 1000;

  private instance: WebSerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private onDisconnect?: () => void;
  private disconnectListeners = new Set<() => void>();
  private readonly parser = new FrameParser();
  private readonly frameListeners = new Set<FrameListener>();

  private disconnectHandler = (event: Event) => {
    if (event.target === this.instance) {
      this.handleDisconnect();
    }
  };

  async init(options: Options): Promise<void> {
    if (this.instance) {
      await this.close();
    }

    try {
      this.instance = options.port;
      const baudRate = options.baudRate || this.SERIAL_BAUD_RATE;
      await this.instance.open({ baudRate });
    } catch (err) {
      this.instance = null;
      console.error('Error opening serial port:', err);
      throw err;
    }

    if (!this.instance.readable || !this.instance.writable) {
      this.instance = null;
      throw new Error('Serial port streams not available');
    }

    const readable = this.instance.readable;
    this.reader = readable.getReader();
    this.writer = this.instance.writable.getWriter();
    this.parser.reset();

    if (options.onDisconnect) {
      this.onDisconnect = options.onDisconnect;
    }

    navigator.serial.addEventListener('disconnect', this.disconnectHandler);
    void this.readLoop(this.reader, readable);
  }

  /**
   * Subscribes to the frames the device sends back (every command is
   * answered, and the chip reports LED changes on its own). Returns the
   * unsubscribe function; a throwing listener does not affect the others.
   */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /**
   * Registers a callback that runs synchronously at the start of a disconnect,
   * before the app-level onDisconnect (the paste engine cancels its run with
   * 'serial-error'; registered from App.tsx so this module stays free of UI
   * imports). Returns the unsubscribe function.
   */
  addDisconnectListener(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  private handleDisconnect(): void {
    if (!this.instance) return;

    for (const listener of Array.from(this.disconnectListeners)) {
      try {
        listener();
      } catch (err) {
        console.error('Disconnect listener failed:', err);
      }
    }

    this.releaseReader();
    this.releaseWriter();
    // a frame cut off by the unplug must not be completed by the next port's bytes
    this.parser.reset();

    this.instance = null;

    if (this.onDisconnect) {
      this.onDisconnect();
      this.onDisconnect = undefined;
    }

    navigator.serial.removeEventListener('disconnect', this.disconnectHandler);
  }

  private releaseReader(): void {
    if (!this.reader) return;
    try {
      this.reader.releaseLock();
    } catch {
      // Lock already released
    }
    this.reader = null;
  }

  private releaseWriter(): void {
    if (!this.writer) return;
    try {
      this.writer.releaseLock();
    } catch {
      // Lock already released
    }
    this.writer = null;
  }

  async write(data: number[]): Promise<void> {
    if (!this.writer) {
      throw new Error('Serial port not initialized');
    }

    try {
      await this.writer.write(new Uint8Array(data));
    } catch (err) {
      if (isDisconnectError(err)) {
        this.handleDisconnect();
        throw new Error('Device disconnected');
      }
      throw err;
    }
  }

  /**
   * The port's only reader while it is open (spec v2 §8.2, §14.8): one read()
   * at a time, every chunk through the frame parser to the onFrame listeners.
   * Unread replies would otherwise pile up in the stream. Ends when the
   * stream is done (close() cancels the reader), on a disconnect, or on a
   * read error after which the port offers no new stream.
   */
  private async readLoop(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    stream: ReadableStream<Uint8Array>
  ): Promise<void> {
    for (;;) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || reader !== this.reader) return;
          if (value) this.dispatch(this.parser.push(value));
        }
      } catch (err) {
        // releasing or replacing a reader rejects its pending read: not an error of this port
        if (reader !== this.reader) return;
        if (isDisconnectError(err)) {
          this.handleDisconnect();
          return;
        }
        console.error('Serial read failed:', err);
        // WebSerial: after a BreakError, FramingError, ParityError or BufferOverrunError the port
        // stays open and `readable` is a new stream; after a fatal error it is null. The same
        // (errored) stream again means there is nothing to resume.
        const next = this.instance?.readable ?? null;
        if (next === null || next === stream || next.locked) return;
        this.releaseReader();
        // the bytes of a frame cut by the error are gone
        this.parser.reset();
        stream = next;
        reader = next.getReader();
        this.reader = reader;
      }
    }
  }

  private dispatch(frames: ParsedFrame[]): void {
    for (const frame of frames) {
      for (const listener of Array.from(this.frameListeners)) {
        try {
          listener(frame);
        } catch (err) {
          console.error('Serial frame listener failed:', err);
        }
      }
    }
  }

  async close(): Promise<void> {
    try {
      if (this.reader) {
        await raceWithTimeout(
          this.reader.cancel().catch(() => {}),
          this.CLEANUP_TIMEOUT
        );
        this.releaseReader();
      }

      if (this.writer) {
        await raceWithTimeout(
          this.writer.close().catch(() => {}),
          this.CLEANUP_TIMEOUT
        );
        this.releaseWriter();
      }

      if (this.instance) {
        await this.instance.close().catch(() => {});
        this.instance = null;
      }

      this.parser.reset();
      navigator.serial.removeEventListener('disconnect', this.disconnectHandler);
    } catch (err) {
      console.error('Error during close:', err);
    }
  }
}
