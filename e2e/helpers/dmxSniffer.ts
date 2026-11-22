import dgram, { type RemoteInfo, type Socket } from "node:dgram";

export const ARTNET_PORT = 6454;
export const SACN_PORT = 5568;
export const OPCODE_ARTDMX = 0x5000;
export const OPCODE_ARTSYNC = 0x5200;
export const OPCODE_ARTPOLL = 0x2000;

export interface ArtNetDmxFrame {
  sequence: number;
  physical: number;
  net: number;
  subnet: number;
  uni: number;
  dmx: Uint8Array;
  from: string;
  receivedAtMs: number;
}

export interface SacnDmxFrame {
  universe: number;
  priority: number;
  sequence: number;
  options: number;
  startCode: number;
  dmx: Uint8Array;
  from: string;
  receivedAtMs: number;
}

export function parseArtNetDmxPacket(
  buf: Buffer,
  from = "0.0.0.0",
  receivedAtMs = Date.now(),
): ArtNetDmxFrame | null {
  if (buf.length < 18) return null;
  if (buf.subarray(0, 8).toString("ascii") !== "Art-Net\0") return null;
  const opcode = buf.readUInt16LE(8);
  if (opcode !== OPCODE_ARTDMX) return null;

  const sequence = buf[12];
  const physical = buf[13];
  const subUni = buf[14];
  const subnet = (subUni >> 4) & 0x0f;
  const uni = subUni & 0x0f;
  const net = buf[15] & 0x7f;
  const length = Math.min(512, buf.readUInt16BE(16));
  const dmx = new Uint8Array(512);
  dmx.set(buf.subarray(18, Math.min(buf.length, 18 + length)));

  return {
    sequence,
    physical,
    net,
    subnet,
    uni,
    dmx,
    from,
    receivedAtMs,
  };
}

export function parseSacnDataPacket(
  buf: Buffer,
  from = "0.0.0.0",
  receivedAtMs = Date.now(),
): SacnDmxFrame | null {
  if (buf.length < 126) return null;
  if (buf.subarray(4, 16).toString("ascii") !== "ASC-E1.17\0\0\0") return null;
  if (buf.readUInt32BE(18) !== 0x00000004) return null;
  if (buf.readUInt32BE(40) !== 0x00000002) return null;

  const priority = buf[108];
  const sequence = buf[111];
  const options = buf[112];
  const universe = buf.readUInt16BE(113);
  const startCode = buf[125];
  const dmx = new Uint8Array(512);
  dmx.set(buf.subarray(126, Math.min(buf.length, 638)));

  return {
    universe,
    priority,
    sequence,
    options,
    startCode,
    dmx,
    from,
    receivedAtMs,
  };
}

export interface DmxSnifferOptions {
  host?: string;
  artnetPort?: number;
  sacnPort?: number;
  enableArtNet?: boolean;
  enableSacn?: boolean;
}

export class DmxSniffer {
  private artnetSocket: Socket | null = null;
  private sacnSocket: Socket | null = null;
  private latestArtNet = new Map<string, ArtNetDmxFrame>();
  private latestSacn = new Map<number, SacnDmxFrame>();
  private artnetWaiters: Array<{
    predicate: (frame: ArtNetDmxFrame) => boolean;
    resolve: (frame: ArtNetDmxFrame) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private sacnWaiters: Array<{
    predicate: (frame: SacnDmxFrame) => boolean;
    resolve: (frame: SacnDmxFrame) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  public artnetPacketCount = 0;
  public sacnPacketCount = 0;

  async start(opts: DmxSnifferOptions = {}): Promise<void> {
    const host = opts.host ?? "0.0.0.0";
    const artnetPort = opts.artnetPort ?? ARTNET_PORT;
    const sacnPort = opts.sacnPort ?? SACN_PORT;

    if (opts.enableArtNet !== false) {
      this.artnetSocket = await this.bindUdp(host, artnetPort, (msg, rinfo) => {
        const frame = parseArtNetDmxPacket(msg, rinfo.address, Date.now());
        if (!frame) return;
        this.artnetPacketCount += 1;
        this.latestArtNet.set(`${frame.net}:${frame.subnet}:${frame.uni}`, frame);
        this.flushArtNetWaiters(frame);
      });
    }

    if (opts.enableSacn !== false) {
      this.sacnSocket = await this.bindUdp(host, sacnPort, (msg, rinfo) => {
        const frame = parseSacnDataPacket(msg, rinfo.address, Date.now());
        if (!frame) return;
        this.sacnPacketCount += 1;
        this.latestSacn.set(frame.universe, frame);
        this.flushSacnWaiters(frame);
      });
    }
  }

  private bindUdp(
    host: string,
    port: number,
    onMessage: (msg: Buffer, rinfo: RemoteInfo) => void,
  ): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      const onError = (err: Error) => {
        sock.close();
        reject(err);
      };
      sock.once("error", onError);
      sock.on("message", onMessage);
      sock.bind(port, host, () => {
        sock.off("error", onError);
        try {
          sock.setBroadcast(true);
        } catch {
          // Ignore broadcast flag errors
        }
        resolve(sock);
      });
    });
  }

  private flushArtNetWaiters(frame: ArtNetDmxFrame): void {
    const remaining: typeof this.artnetWaiters = [];
    for (const waiter of this.artnetWaiters) {
      if (waiter.predicate(frame)) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        remaining.push(waiter);
      }
    }
    this.artnetWaiters = remaining;
  }

  private flushSacnWaiters(frame: SacnDmxFrame): void {
    const remaining: typeof this.sacnWaiters = [];
    for (const waiter of this.sacnWaiters) {
      if (waiter.predicate(frame)) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        remaining.push(waiter);
      }
    }
    this.sacnWaiters = remaining;
  }

  getLatestArtNet(net = 0, subnet = 0, uni = 0): ArtNetDmxFrame | null {
    return this.latestArtNet.get(`${net}:${subnet}:${uni}`) ?? null;
  }

  getLatestSacn(universe = 1): SacnDmxFrame | null {
    return this.latestSacn.get(universe) ?? null;
  }

  waitForArtNetFrame(
    predicate: (frame: ArtNetDmxFrame) => boolean,
    timeoutMs = 5000,
  ): Promise<ArtNetDmxFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.artnetWaiters = this.artnetWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for matching Art-Net frame`));
      }, timeoutMs);
      this.artnetWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForSacnFrame(
    predicate: (frame: SacnDmxFrame) => boolean,
    timeoutMs = 5000,
  ): Promise<SacnDmxFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sacnWaiters = this.sacnWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for matching sACN frame`));
      }, timeoutMs);
      this.sacnWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  reset(): void {
    this.latestArtNet.clear();
    this.latestSacn.clear();
    this.artnetPacketCount = 0;
    this.sacnPacketCount = 0;
  }

  async stop(): Promise<void> {
    for (const waiter of this.artnetWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("DmxSniffer stopped"));
    }
    for (const waiter of this.sacnWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("DmxSniffer stopped"));
    }
    this.artnetWaiters = [];
    this.sacnWaiters = [];

    const closeSocket = (sock: Socket | null) =>
      new Promise<void>((resolve) => {
        if (!sock) return resolve();
        try {
          sock.close(() => resolve());
        } catch {
          resolve();
        }
      });

    await Promise.all([
      closeSocket(this.artnetSocket),
      closeSocket(this.sacnSocket),
    ]);
    this.artnetSocket = null;
    this.sacnSocket = null;
  }
}
