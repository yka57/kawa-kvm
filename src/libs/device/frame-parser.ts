/**
 * CH9329 reply frames (spec v2 §8.1, pure): `57 AB ADDR CMD LEN DATA… SUM`,
 * SUM = low byte of the sum of every byte from 0x57 through the last data
 * byte. Frames may be split across serial chunks; anything that does not
 * check out costs one byte and the parser looks for the next header.
 */

export interface ParsedFrame {
  addr: number;
  cmd: number;
  data: number[];
}

const HEAD1 = 0x57;
const HEAD2 = 0xab;
/** Header, address, command, length. */
const PREFIX_LENGTH = 5;
/** The chip's frames carry at most 64 data bytes; anything longer is a false header. */
const MAX_DATA_LENGTH = 64;

export class FrameParser {
  private buffer: number[] = [];

  push(bytes: ArrayLike<number>): ParsedFrame[] {
    for (let i = 0; i < bytes.length; i++) this.buffer.push(bytes[i] & 0xff);

    const frames: ParsedFrame[] = [];
    for (;;) {
      this.skipToHeader();
      const buf = this.buffer;
      if (buf.length < PREFIX_LENGTH) break;

      const length = buf[4];
      if (length > MAX_DATA_LENGTH) {
        buf.shift();
        continue;
      }
      const frameLength = PREFIX_LENGTH + length + 1;
      if (buf.length < frameLength) break;

      let sum = 0;
      for (let i = 0; i < frameLength - 1; i++) sum += buf[i];
      if ((sum & 0xff) !== buf[frameLength - 1]) {
        buf.shift();
        continue;
      }

      frames.push({ addr: buf[2], cmd: buf[3], data: buf.slice(PREFIX_LENGTH, frameLength - 1) });
      this.buffer = buf.slice(frameLength);
    }
    return frames;
  }

  /** Drops a partial frame (the port was closed or reopened). */
  reset(): void {
    this.buffer = [];
  }

  /** Discards bytes before the next `57 AB`, keeping a trailing 0x57 that may start one. */
  private skipToHeader(): void {
    const buf = this.buffer;
    let start = 0;
    while (start < buf.length) {
      if (buf[start] === HEAD1 && (start + 1 === buf.length || buf[start + 1] === HEAD2)) break;
      start++;
    }
    if (start > 0) this.buffer = buf.slice(start);
  }
}
