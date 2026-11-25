import dgram from "node:dgram";
import process from "node:process";

function getArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const durationMs = Number(getArg("--duration", "2500"));
const artnetPort = Number(getArg("--artnet-port", "6454"));
const sacnPort = Number(getArg("--sacn-port", "5568"));
const host = getArg("--host", "0.0.0.0");

function parseArtNet(buf) {
  if (buf.length < 18) return null;
  if (buf.subarray(0, 8).toString("ascii") !== "Art-Net\0") return null;
  const opcode = buf.readUInt16LE(8);
  if (opcode !== 0x5000) return { opcode };
  const subUni = buf[14];
  const net = buf[15] & 0x7f;
  const subnet = (subUni >> 4) & 0x0f;
  const uni = subUni & 0x0f;
  const length = Math.min(512, buf.readUInt16BE(16));
  const dmx = buf.subarray(18, 18 + length);
  const nonZero = [];
  for (let i = 0; i < dmx.length; i++) {
    if (dmx[i] > 0) nonZero.push({ ch: i + 1, val: dmx[i] });
  }
  return {
    opcode,
    sequence: buf[12],
    net,
    subnet,
    uni,
    nonZero,
  };
}

function parseSacn(buf) {
  if (buf.length < 126) return null;
  if (buf.subarray(4, 16).toString("ascii") !== "ASC-E1.17\0\0\0") return null;
  if (buf.readUInt32BE(18) !== 0x00000004) return null;
  if (buf.readUInt32BE(40) !== 0x00000002) return null;
  const priority = buf[108];
  const sequence = buf[111];
  const universe = buf.readUInt16BE(113);
  const dmx = buf.subarray(126, Math.min(buf.length, 638));
  const nonZero = [];
  for (let i = 0; i < dmx.length; i++) {
    if (dmx[i] > 0) nonZero.push({ ch: i + 1, val: dmx[i] });
  }
  return { universe, priority, sequence, nonZero };
}

const summary = {
  durationMs,
  artnetPort,
  sacnPort,
  artnetDmxPackets: 0,
  artnetSyncPackets: 0,
  artnetPollPackets: 0,
  sacnPackets: 0,
  latestArtNet: {},
  latestSacn: {},
  bindErrors: [],
};

const sockets = [];

function bindSocket(port, onMessage) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (err) => {
      summary.bindErrors.push(`UDP ${port}: ${err.message}`);
      try {
        sock.close();
      } catch {
        // Ignore
      }
      resolve(null);
    });
    sock.on("message", onMessage);
    sock.bind(port, host, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // Ignore
      }
      sockets.push(sock);
      resolve(sock);
    });
  });
}

async function main() {
  await bindSocket(artnetPort, (msg, rinfo) => {
    const parsed = parseArtNet(msg);
    if (!parsed) return;
    if (parsed.opcode === 0x5000) {
      summary.artnetDmxPackets += 1;
      const key = `${parsed.net}:${parsed.subnet}:${parsed.uni}`;
      summary.latestArtNet[key] = {
        from: rinfo.address,
        sequence: parsed.sequence,
        nonZero: parsed.nonZero,
      };
    } else if (parsed.opcode === 0x5200) {
      summary.artnetSyncPackets += 1;
    } else if (parsed.opcode === 0x2000) {
      summary.artnetPollPackets += 1;
    }
  });

  await bindSocket(sacnPort, (msg, rinfo) => {
    const parsed = parseSacn(msg);
    if (!parsed) return;
    summary.sacnPackets += 1;
    summary.latestSacn[String(parsed.universe)] = {
      from: rinfo.address,
      priority: parsed.priority,
      sequence: parsed.sequence,
      nonZero: parsed.nonZero,
    };
  });

  await new Promise((r) => setTimeout(r, durationMs));

  for (const sock of sockets) {
    try {
      sock.close();
    } catch {
      // Ignore
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
