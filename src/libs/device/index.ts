import { realClock, type Clock } from '@/libs/clock';
import { hidLog, type HidKind } from '@/libs/debug/hid-log';

import { CmdEvent, CmdPacket } from './proto.ts';
import { SerialPort } from './serial-port.ts';

/** Keyboard LED state of the target, as the CH9329 reports it (spec v2 §8.3). */
export interface LockState {
  num: boolean;
  caps: boolean;
  scroll: boolean;
  /** Chip version byte: 0x30 + minor (0x38 = V1.8). */
  version: number;
}

/** Replies carry `cmd | 0x80`; errors `cmd | 0xC0` with one status byte. */
const INFO_REPLY = CmdEvent.GET_INFO | 0x80;
const INFO_ERROR = CmdEvent.GET_INFO | 0xc0;
/** GET_INFO `usb` byte when the target has enumerated the device; the LED bits mean nothing otherwise. */
const USB_ENUMERATED = 0x01;
const LOCK_STATE_ATTEMPTS = 2;

/** GET_INFO reply data: `ver usb led 0 0 0 0 0`, led bit0 Num, bit1 Caps, bit2 Scroll. */
function decodeLockState(data: readonly number[]): LockState | null {
  if (data.length < 3 || data[1] !== USB_ENUMERATED) return null;
  const led = data[2];
  return {
    num: (led & 0x01) !== 0,
    caps: (led & 0x02) !== 0,
    scroll: (led & 0x04) !== 0,
    version: data[0]
  };
}

type InfoAnswer = LockState | null | 'retry';

export class Device {
  addr: number;
  serialPort: SerialPort;
  private readonly clock: Clock;
  private lastLockState: LockState | null = null;
  private lockStateRequest: Promise<LockState | null> | null = null;

  constructor(clock: Clock = realClock) {
    this.addr = 0x00;
    this.serialPort = new SerialPort();
    this.clock = clock;
    // the chip pushes a GET_INFO reply on its own ~15 ms after the target changes its LEDs
    this.serialPort.onFrame((frame) => {
      if (frame.cmd === INFO_REPLY) this.lastLockState = decodeLockState(frame.data);
    });
  }

  /** The lock state from the latest GET_INFO reply, requested or not; null when unknown. */
  get lockState(): LockState | null {
    return this.lastLockState;
  }

  /**
   * Asks the device for the target's lock state: the first GET_INFO reply
   * after the request, one retry after an error reply or `timeoutMs` without
   * an answer. Null when nobody answers or the target has not enumerated the
   * device. Concurrent calls share the request in flight.
   */
  getLockState(timeoutMs = 300): Promise<LockState | null> {
    if (this.lockStateRequest === null) {
      this.lockStateRequest = this.requestLockState(timeoutMs).finally(() => {
        this.lockStateRequest = null;
      });
    }
    return this.lockStateRequest;
  }

  async sendKeyboardData(report: number[]): Promise<void> {
    const cmdData = new CmdPacket(this.addr, CmdEvent.SEND_KB_GENERAL_DATA, report).encode();
    await this.writeLogged('kb', report, cmdData);
  }

  async sendMouseData(report: number[]): Promise<void> {
    if (report.length === 0) return;

    const isRelative = report[0] === 0x01;
    const cmdEvent = isRelative ? CmdEvent.SEND_MS_REL_DATA : CmdEvent.SEND_MS_ABS_DATA;
    const cmdData = new CmdPacket(this.addr, cmdEvent, report).encode();
    await this.writeLogged(isRelative ? 'rel' : 'abs', report, cmdData);
  }

  private async requestLockState(timeoutMs: number): Promise<LockState | null> {
    for (let attempt = 0; attempt < LOCK_STATE_ATTEMPTS; attempt++) {
      const answer = await this.queryInfo(timeoutMs);
      if (answer !== 'retry') return answer;
    }
    return null;
  }

  /**
   * One GET_INFO round trip. Acks of earlier reports may still arrive first,
   * so only a GET_INFO reply or error counts. Not in the HID log: nothing
   * reaches the target.
   */
  private queryInfo(timeoutMs: number): Promise<InfoAnswer> {
    const { clock } = this;
    return new Promise<InfoAnswer>((resolve) => {
      // listening before the write: frames are dispatched asynchronously, none can be missed
      const unsubscribe = this.serialPort.onFrame((frame) => {
        if (frame.cmd === INFO_REPLY) finish(decodeLockState(frame.data));
        else if (frame.cmd === INFO_ERROR) finish('retry');
      });
      const timer = clock.setTimeout(() => finish('retry'), timeoutMs);
      let settled = false;

      function finish(answer: InfoAnswer): void {
        if (settled) return;
        settled = true;
        unsubscribe();
        clock.clearTimeout(timer);
        resolve(answer);
      }

      const request = new CmdPacket(this.addr, CmdEvent.GET_INFO).encode();
      this.serialPort.write(request).catch(() => finish(null));
    });
  }

  /**
   * HID log tap (spec §6.2): the payload is recorded before the write and a
   * failed write is marked on its entry. The frame on the wire is unchanged.
   */
  private async writeLogged(kind: HidKind, report: number[], cmdData: number[]): Promise<void> {
    const entry = hidLog.push(kind, report);
    try {
      await this.serialPort.write(cmdData);
    } catch (err) {
      hidLog.fail(entry, err);
      throw err;
    }
  }
}

export const device = new Device();
