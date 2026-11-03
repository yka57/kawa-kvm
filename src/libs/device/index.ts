import { hidLog, type HidKind } from '@/libs/debug/hid-log';

import { CmdEvent, CmdPacket, InfoPacket } from './proto.ts';
import { SerialPort } from './serial-port.ts';

export class Device {
  addr: number;
  serialPort: SerialPort;

  constructor() {
    this.addr = 0x00;
    this.serialPort = new SerialPort();
  }

  async getInfo() {
    const data = new CmdPacket(this.addr, CmdEvent.GET_INFO).encode();
    await this.serialPort.write(data);

    const rsp = await this.serialPort.read(14);
    const rspPacket = new CmdPacket(-1, -1, rsp);
    return new InfoPacket(rspPacket.DATA);
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
