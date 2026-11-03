import { describe, expect, it } from 'vitest';

import { FrameParser } from './frame-parser';

/** A CH9329 frame with a correct checksum (sum of every byte through the last data byte). */
function frameBytes(cmd: number, data: number[], addr = 0x00): number[] {
  const bytes = [0x57, 0xab, addr, cmd, data.length, ...data];
  return [...bytes, bytes.reduce((sum, byte) => sum + byte, 0) & 0xff];
}

const ACK = [0x57, 0xab, 0x00, 0x82, 0x01, 0x00, 0x85]; // keyboard report acknowledged
const INFO_DATA = [0x38, 0x01, 0x02, 0, 0, 0, 0, 0]; // V1.8, enumerated, Caps on
const INFO = frameBytes(0x81, INFO_DATA);
const ERROR = frameBytes(0xc1, [0xe1]);

describe('FrameParser', () => {
  it('parses the keyboard ack, a GET_INFO reply and an error reply', () => {
    expect(frameBytes(0x82, [0x00])).toEqual(ACK);
    expect(INFO).toHaveLength(14);

    const parser = new FrameParser();
    expect(parser.push(ACK)).toEqual([{ addr: 0, cmd: 0x82, data: [0x00] }]);
    expect(parser.push(INFO)).toEqual([{ addr: 0, cmd: 0x81, data: INFO_DATA }]);
    expect(parser.push(ERROR)).toEqual([{ addr: 0, cmd: 0xc1, data: [0xe1] }]);
    expect(parser.push(frameBytes(0x01, [], 0x05))).toEqual([{ addr: 5, cmd: 0x01, data: [] }]);
  });

  it('returns every frame of a chunk in order, from a Uint8Array too', () => {
    const parser = new FrameParser();
    const frames = parser.push(new Uint8Array([...ACK, ...ACK, ...INFO]));
    expect(frames.map((f) => f.cmd)).toEqual([0x82, 0x82, 0x81]);
  });

  it('reassembles frames split across chunks, even byte by byte', () => {
    const parser = new FrameParser();
    const stream = [...ACK, ...INFO, ...ERROR];
    const cmds: number[] = [];
    for (const byte of stream) {
      for (const frame of parser.push([byte])) cmds.push(frame.cmd);
    }
    expect(cmds).toEqual([0x82, 0x81, 0xc1]);

    expect(parser.push(INFO.slice(0, 1))).toEqual([]); // just 0x57
    expect(parser.push(INFO.slice(1, 5))).toEqual([]);
    expect(parser.push(INFO.slice(5))).toEqual([{ addr: 0, cmd: 0x81, data: INFO_DATA }]);
  });

  it('resyncs after garbage, a lone 0x57 and a stray header', () => {
    const parser = new FrameParser();
    const garbage = [0x00, 0xff, 0x57, 0x00, 0xab, 0x57];
    expect(parser.push([...garbage, ...ACK])).toEqual([{ addr: 0, cmd: 0x82, data: [0] }]);
    // a header whose "frame" fails the checksum costs one byte, the real frame behind it parses
    expect(parser.push([0x57, 0xab, ...ACK])).toEqual([{ addr: 0, cmd: 0x82, data: [0] }]);
    // the tail of a frame cut off before we started reading
    expect(parser.push([...INFO.slice(6), ...INFO])).toEqual([
      { addr: 0, cmd: 0x81, data: INFO_DATA }
    ]);
  });

  it('rejects LEN > 64 as a false header', () => {
    const parser = new FrameParser();
    const longest = frameBytes(0x87, Array(64).fill(1));
    expect(parser.push(longest)).toHaveLength(1);

    const bogus = [0x57, 0xab, 0x00, 0x81, 65];
    // without the LEN check this would wait for 71 bytes and swallow the ack
    expect(parser.push([...bogus, ...ACK])).toEqual([{ addr: 0, cmd: 0x82, data: [0] }]);
  });

  it('requires the checksum to cover the last data byte', () => {
    const parser = new FrameParser();
    const data = [0x38, 0x01, 0x02, 0, 0, 0, 0, 0x10];
    const head = [0x57, 0xab, 0x00, 0x81, data.length, ...data];
    // upstream CmdPacket.decode summed up to the byte before the last data byte
    const shortSum = head.slice(0, -1).reduce((sum, byte) => sum + byte, 0) & 0xff;
    expect(parser.push([...head, shortSum])).toEqual([]);
    expect(parser.push(frameBytes(0x81, data))).toEqual([{ addr: 0, cmd: 0x81, data }]);
  });

  it('reset() drops a partial frame', () => {
    const parser = new FrameParser();
    expect(parser.push(INFO.slice(0, 8))).toEqual([]);
    parser.reset();
    expect(parser.push(INFO.slice(8))).toEqual([]);
    expect(parser.push(ACK)).toEqual([{ addr: 0, cmd: 0x82, data: [0] }]);
  });
});
