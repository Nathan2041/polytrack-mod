// Copyright (c) 2026 cwcinc. All rights reserved. Unauthorized use prohibited.


// PolyTrack new track encoding (saves ~42% of characters on average vs v5 save codes)
//
// Body format:
//   env u8, sun u8
//   minX,minY,minZ varint  W,H,D varuint  numGroups varuint
//   per group:
//     partId u8, count varuint
//     count x varuint linear-index deltas
//     paletteSize varuint, paletteSize x 2 bytes [(rot|axis<<2), color]
//     count x ceil(log2(paletteSize)) bits palette indices, byte-aligned
//     count x varuint checkpointOrder  (checkpoint partIds only)
//     count x varuint startOrder       (start partIds only)

class BitWriter {
  constructor() { this.bytes = []; this.buf = 0; this.bits = 0; }
  write(value, width) {
    for (let i = 0; i < width; i++) {
      this.buf |= ((value >> i) & 1) << this.bits;
      if (++this.bits === 8) { this.bytes.push(this.buf); this.buf = 0; this.bits = 0; }
    }
  }
  flush() {
    if (this.bits > 0) { this.bytes.push(this.buf); this.buf = 0; this.bits = 0; }
    return this.bytes;
  }
}

class BitReader {
  constructor(bytes, pos) { this.bytes = bytes; this.pos = pos; this.bitPos = 0; }
  read(width) {
    let result = 0;
    for (let i = 0; i < width; i++) {
      result |= ((this.bytes[this.pos] >> this.bitPos) & 1) << i;
      if (++this.bitPos === 8) { this.bitPos = 0; this.pos++; }
    }
    return result;
  }
  align() {
    if (this.bitPos > 0) { this.bitPos = 0; this.pos++; }
    return this.pos;
  }
}

class VarintWriter {
  static writeVarUint(out, v) {
    v = v >>> 0;
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v & 0x7f);
  }
  static writeVarInt(out, v) {
    VarintWriter.writeVarUint(out, ((v << 1) ^ (v >> 31)) >>> 0);
  }
  static readVarUint(bytes, pos) {
    let result = 0, shift = 0, b, safety = 5;
    do {
      if (pos >= bytes.length) throw new Error("truncated varint");
      if (safety-- <= 0) throw new Error("varint too long");
      b = bytes[pos++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return [result >>> 0, pos];
  }
  static readVarInt(bytes, pos) {
    const [u, next] = VarintWriter.readVarUint(bytes, pos);
    return [(u >>> 1) ^ -(u & 1), next];
  }
}

class BetterTrackCodes {
  static EXPORT_PREFIX = "CWCTrack1";
  static SAVE_PREFIX = "CWC1";
  static deps = null;

  #parts;
  #partIds;
  #getEnvironment;
  #getSunDirection;

  constructor(parts, partIds, getEnvironment, getSunDirection) {
    this.#parts = parts;
    this.#partIds = partIds;
    this.#getEnvironment = getEnvironment;
    this.#getSunDirection = getSunDirection;
  }

  // Inject needed webpack module dependencies
  static init(dependencies) {
    const required = [
      "TrackData", "TrackEnvironment", "SunDirection", "Part",
      "TrackPartColorId", "TrackPartRotationAxis", "TrackPartManager",
      "Base62", "pako",
    ];
    for (const dep of required) {
      if (dependencies[dep] == null) {
        throw new Error(`BetterTrackCodes init missing '${dep}'`);
      }
    }
    if (dependencies.pako.Deflate == null || dependencies.pako.Inflate == null) {
      throw new Error("BetterTrackCodes init missing Deflate or Inflate");
    }
    BetterTrackCodes.deps = dependencies;
  }

  static #requireDeps() {
    if (BetterTrackCodes.deps == null) {
      throw new Error("BetterTrackCodes not initialized");
    }
    return BetterTrackCodes.deps;
  }

  // windowBits scaled to data size for optimization
  static #pickWindowBits(byteLen) {
    return Math.max(9, Math.min(15, Math.ceil(Math.log2(byteLen + 1))));
  }

  static _deflate(bytes) {
    const { pako } = BetterTrackCodes.#requireDeps();
    const wb = BetterTrackCodes.#pickWindowBits(bytes.length);
    const d = new pako.Deflate({ level: 9, windowBits: wb, memLevel: 9 });
    d.push(bytes, true);
    return d.result;
  }

  static #inflate(bytes) {
    const { pako } = BetterTrackCodes.#requireDeps();
    const i = new pako.Inflate();
    i.push(bytes, true);
    return i.err ? null : i.result;
  }

  toByteArray() {
    const { TrackPartManager } = BetterTrackCodes.#requireDeps();
    const out = [];
    const partsMap = this.#parts;
    const partIds = this.#partIds;

    out.push(this.#getEnvironment() & 0xff);
    out.push(this.#getSunDirection().representation & 0xff);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const [, list] of partsMap) {
      for (const b of list) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.z < minZ) minZ = b.z;
        if (b.x > maxX) maxX = b.x;
        if (b.y > maxY) maxY = b.y;
        if (b.z > maxZ) maxZ = b.z;
      }
    }
    if (!Number.isFinite(minX)) {
      minX = 0; minY = 0; minZ = 0;
      maxX = 0; maxY = 0; maxZ = 0;
    }
    const W = maxX - minX + 1;
    const H = maxY - minY + 1;
    const D = maxZ - minZ + 1;

    VarintWriter.writeVarInt(out, minX);
    VarintWriter.writeVarInt(out, minY);
    VarintWriter.writeVarInt(out, minZ);
    VarintWriter.writeVarUint(out, W);
    VarintWriter.writeVarUint(out, H);
    VarintWriter.writeVarUint(out, D);

    let nonEmpty = 0;
    for (const id of partIds) {
      const list = partsMap.get(id);
      if (list && list.length > 0) nonEmpty++;
    }
    VarintWriter.writeVarUint(out, nonEmpty);

    for (const partId of partIds) {
      const list = partsMap.get(partId);
      if (!list || list.length === 0) continue;
      if (partId < 0 || partId > 255) throw new Error("Part id out of range");

      const isCheckpoint = TrackPartManager.checkpointPartIds.includes(partId);
      const isStart = TrackPartManager.startPartIds.includes(partId);

      const entries = list.map(b => ({
        b,
        linear: (b.z - minZ) * W * H + (b.y - minY) * W + (b.x - minX),
      }));
      entries.sort((a, c) => a.linear - c.linear);

      out.push(partId & 0xff);
      VarintWriter.writeVarUint(out, entries.length);

      let prev = 0;
      for (const e of entries) {
        VarintWriter.writeVarUint(out, e.linear - prev);
        prev = e.linear;
      }

      const paletteMap = new Map();
      const palette = [];
      const indices = new Array(entries.length);
      for (let i = 0; i < entries.length; i++) {
        const b = entries[i].b;
        const attr = (b.rotation & 3) | ((b.rotationAxis & 7) << 2);
        const color = b.color & 0xff;
        const key = (attr << 8) | color;
        let idx = paletteMap.get(key);
        if (idx === undefined) {
          idx = palette.length;
          paletteMap.set(key, idx);
          palette.push(key);
        }
        indices[i] = idx;
      }
      VarintWriter.writeVarUint(out, palette.length);
      for (const k of palette) out.push((k >> 8) & 0xff, k & 0xff);

      const bits = palette.length <= 1 ? 0 : Math.ceil(Math.log2(palette.length));
      if (bits > 0) {
        const bw = new BitWriter();
        for (const idx of indices) bw.write(idx, bits);
        for (const byte of bw.flush()) out.push(byte);
      }

      if (isCheckpoint) {
        for (const e of entries) {
          if (e.b.checkpointOrder == null) throw new Error("Checkpoint missing order");
          VarintWriter.writeVarUint(out, e.b.checkpointOrder);
        }
      }
      if (isStart) {
        for (const e of entries) {
          if (e.b.startOrder == null) throw new Error("Start missing order");
          VarintWriter.writeVarUint(out, e.b.startOrder);
        }
      }
    }

    return new Uint8Array(out);
  }

  toSaveString() {
    const { Base62 } = BetterTrackCodes.#requireDeps();
    return BetterTrackCodes.SAVE_PREFIX + Base62.encode(BetterTrackCodes._deflate(this.toByteArray()));
  }

  toExportString(meta) {
    const { Base62 } = BetterTrackCodes.#requireDeps();

    const nameBytes = new TextEncoder().encode(meta.name);
    const authorBytes = meta.author ? new TextEncoder().encode(meta.author) : new Uint8Array(0);

    const header = [];
    VarintWriter.writeVarUint(header, nameBytes.length);
    for (const b of nameBytes) header.push(b);
    VarintWriter.writeVarUint(header, authorBytes.length);
    for (const b of authorBytes) header.push(b);
    if (meta.lastModified == null) {
      header.push(0);
    } else {
      header.push(1);
      VarintWriter.writeVarUint(header, Math.floor(meta.lastModified.getTime() / 1000));
    }

    const body = this.toByteArray();
    const full = new Uint8Array(header.length + body.length);
    full.set(header, 0);
    full.set(body, header.length);

    return BetterTrackCodes.EXPORT_PREFIX + Base62.encode(BetterTrackCodes._deflate(full));
  }

  // Returns a TrackData or null on any parse / validation error
  static fromByteArray(data, offset) {
    const {
      TrackData, TrackEnvironment, SunDirection, Part,
      TrackPartColorId, TrackPartRotationAxis, TrackPartManager,
    } = BetterTrackCodes.#requireDeps();

    try {
      let pos = offset | 0;

      if (data.length - pos < 2) return null;
      const environment = data[pos++];
      if (!(environment in TrackEnvironment)) return null;
      const sunByte = data[pos++];
      if (!Number.isSafeInteger(sunByte) || sunByte < 0 || sunByte >= 180) return null;

      const td = new TrackData(environment, new SunDirection(sunByte));

      let minX, minY, minZ, W, H, D, numGroups;
      [minX, pos] = VarintWriter.readVarInt(data, pos);
      [minY, pos] = VarintWriter.readVarInt(data, pos);
      [minZ, pos] = VarintWriter.readVarInt(data, pos);
      [W, pos] = VarintWriter.readVarUint(data, pos);
      [H, pos] = VarintWriter.readVarUint(data, pos);
      [D, pos] = VarintWriter.readVarUint(data, pos);
      [numGroups, pos] = VarintWriter.readVarUint(data, pos);
      if (W <= 0 || H <= 0 || D <= 0) return null;
      if (numGroups > data.length - pos) return null;

      const WH = W * H;

      for (let g = 0; g < numGroups; g++) {
        if (pos >= data.length) return null;
        const partId = data[pos++];
        if (!(partId in Part)) return null;

        let count;
        [count, pos] = VarintWriter.readVarUint(data, pos);
        if (count > data.length - pos) return null;

        const isCheckpoint = TrackPartManager.checkpointPartIds.includes(partId);
        const isStart = TrackPartManager.startPartIds.includes(partId);

        const linears = new Array(count);
        let running = 0;
        for (let i = 0; i < count; i++) {
          let delta;
          [delta, pos] = VarintWriter.readVarUint(data, pos);
          running += delta;
          linears[i] = running;
        }

        let paletteSize;
        [paletteSize, pos] = VarintWriter.readVarUint(data, pos);
        if (paletteSize === 0 && count > 0) return null;
        if (paletteSize * 2 > data.length - pos) return null;
        const palette = new Array(paletteSize);
        for (let i = 0; i < paletteSize; i++) {
          const attr = data[pos++];
          const color = data[pos++];
          const rotation = attr & 3;
          const rotationAxis = (attr >> 2) & 7;
          if (!(rotationAxis in TrackPartRotationAxis)) return null;
          if (!(color in TrackPartColorId)) return null;
          palette[i] = { rotation, rotationAxis, color };
        }

        const bits = paletteSize <= 1 ? 0 : Math.ceil(Math.log2(paletteSize));
        const idxs = new Array(count);
        if (bits === 0) {
          idxs.fill(0);
        } else {
          if (data.length - pos < Math.ceil(count * bits / 8)) return null;
          const br = new BitReader(data, pos);
          for (let i = 0; i < count; i++) {
            const idx = br.read(bits);
            if (idx >= paletteSize) return null;
            idxs[i] = idx;
          }
          pos = br.align();
        }

        let checkpointOrders = null;
        if (isCheckpoint) {
          checkpointOrders = new Array(count);
          for (let i = 0; i < count; i++) {
            let o;
            [o, pos] = VarintWriter.readVarUint(data, pos);
            checkpointOrders[i] = o;
          }
        }
        let startOrders = null;
        if (isStart) {
          startOrders = new Array(count);
          for (let i = 0; i < count; i++) {
            let o;
            [o, pos] = VarintWriter.readVarUint(data, pos);
            startOrders[i] = o;
          }
        }

        for (let i = 0; i < count; i++) {
          const lin = linears[i];
          const z = Math.floor(lin / WH);
          const rem = lin - z * WH;
          const y = Math.floor(rem / W);
          const x = rem - y * W;
          const p = palette[idxs[i]];
          td.addPart(
            x + minX, y + minY, z + minZ,
            partId,
            p.rotation, p.rotationAxis, p.color,
            checkpointOrders ? checkpointOrders[i] : null,
            startOrders ? startOrders[i] : null,
          );
        }
      }
      return td;
    } catch {
      return null;
    }
  }

  // Returns TrackData or null
  static fromSaveString(str) {
    if (!str.startsWith(BetterTrackCodes.SAVE_PREFIX)) return null;
    const { Base62 } = BetterTrackCodes.#requireDeps();
    const payload = Base62.decode(str.slice(BetterTrackCodes.SAVE_PREFIX.length));
    if (payload == null) return null;
    const bytes = BetterTrackCodes.#inflate(payload);
    if (!(bytes instanceof Uint8Array)) return null;
    return BetterTrackCodes.fromByteArray(bytes, 0);
  }

  // Returns { trackMetadata, trackData } (matching V5) or null
  static fromExportString(str) {
    if (!str.startsWith(BetterTrackCodes.EXPORT_PREFIX)) return null;
    const { Base62 } = BetterTrackCodes.#requireDeps();
    const payload = Base62.decode(str.slice(BetterTrackCodes.EXPORT_PREFIX.length));
    if (payload == null) return null;
    const bytes = BetterTrackCodes.#inflate(payload);
    if (!(bytes instanceof Uint8Array)) return null;

    try {
      let pos = 0;

      let nameLen;
      [nameLen, pos] = VarintWriter.readVarUint(bytes, pos);
      if (bytes.length - pos < nameLen) return null;
      const name = new TextDecoder("utf-8").decode(bytes.subarray(pos, pos + nameLen));
      pos += nameLen;

      let authorLen;
      [authorLen, pos] = VarintWriter.readVarUint(bytes, pos);
      if (bytes.length - pos < authorLen) return null;
      const author = authorLen > 0
        ? new TextDecoder("utf-8").decode(bytes.subarray(pos, pos + authorLen))
        : null;
      pos += authorLen;

      if (bytes.length - pos < 1) return null;
      const hasTime = bytes[pos++];
      let lastModified = null;
      if (hasTime === 1) {
        let t;
        [t, pos] = VarintWriter.readVarUint(bytes, pos);
        lastModified = new Date(t * 1000);
      } else if (hasTime !== 0) {
        return null;
      }

      const trackData = BetterTrackCodes.fromByteArray(bytes, pos);
      if (trackData == null) return null;
      return { trackMetadata: { name, author, lastModified }, trackData };
    } catch {
      return null;
    }
  }
}


/**
 * TESTING / PROFILING UTILITIES
 * Used to verify correctness and measure size reductions of the new encoding against a variety of track codes
 */


// Deep comparison of two TrackData instances
// Returns null on match, or a reason string on mismatch
function deepCompareTracks(a, b) {
  if (a.environment !== b.environment) {
    return `environment ${a.environment} vs ${b.environment}`;
  }
  const sunA = a.sunDirection.representation;
  const sunB = b.sunDirection.representation;
  if (sunA !== sunB) return `sunDirection ${sunA} vs ${sunB}`;

  if (a.numberOfParts !== b.numberOfParts) {
    return `numberOfParts ${a.numberOfParts} vs ${b.numberOfParts}`;
  }

  const collect = (td) => {
    const all = [];
    td.forEachPart((x, y, z, partId, rotation, rotationAxis, color, checkpointOrder, startOrder) => {
      all.push({ x, y, z, partId, rotation, rotationAxis, color, checkpointOrder, startOrder });
    });
    all.sort((p, q) =>
      (p.partId - q.partId) ||
      (p.x - q.x) || (p.y - q.y) || (p.z - q.z) ||
      (p.rotation - q.rotation) || (p.rotationAxis - q.rotationAxis) ||
      (p.color - q.color) ||
      ((p.checkpointOrder ?? -1) - (q.checkpointOrder ?? -1)) ||
      ((p.startOrder ?? -1) - (q.startOrder ?? -1))
    );
    return all;
  };

  const partsA = collect(a);
  const partsB = collect(b);

  const fields = ["x", "y", "z", "partId", "rotation", "rotationAxis", "color", "checkpointOrder", "startOrder"];
  for (let i = 0; i < partsA.length; i++) {
    for (const k of fields) {
      const va = partsA[i][k] ?? null;
      const vb = partsB[i][k] ?? null;
      if (va !== vb) return `block #${i} field '${k}': ${va} vs ${vb}`;
    }
  }
  return null;
}

// Profiles an array of track codes or { name, data } objects
// Decodes each with both fromSaveString and fromExportString, re-encodes, and verifies equivalence
// Logs detailed results and a summary of size reductions and verifications
function profileEncoding(inputs) {
  const results = [];
  const failed = [];
  const skipped = [];

  for (const [idx, item] of inputs.entries()) {
    const name = typeof item === "string" ? null : item?.name ?? null;
    const input = typeof item === "string" ? item : item?.data;

    if (typeof input !== "string") {
      failed.push({ idx, name, reason: "not a string" });
      continue;
    }
    if (input.startsWith("PT3") || input.startsWith("PolyTrack3")) {
      skipped.push({ idx, name, reason: "already v6" });
      continue;
    }

    // Decode original string (try save and export)
    let td = null, meta = null, kind = null;
    try {
      td = TrackData.fromSaveString(input);
      if (td) {
        kind = "save";
      } else {
        console.log(input.slice(0, 30) + "...");
        const exp = TrackData.fromExportString(input);
        if (exp && exp.trackData) {
          td = exp.trackData;
          meta = exp.trackMetadata ?? { name: "profile", author: null, lastModified: null };
          kind = "export";
        }
      }
    } catch (e) {
      failed.push({ idx, name, reason: `decode threw: ${e.message}` });
      continue;
    }
    if (!td) {
      failed.push({ idx, name, reason: "no importer matched" });
      continue;
    }

    // Run verification checks and collect failure reasons
    const reasons = [];
    const exportMeta = meta ?? { name: name ?? "profile", author: null, lastModified: null };

    // Encode both ways for later
    let newSave = null, newExport = null;
    try {
      newSave = td.toCwcSaveString();
      newExport = td.toCwcExportString(exportMeta);
    } catch (e) {
      failed.push({ idx, name, reason: `encode threw: ${e.message}` });
      continue;
    }

    // Compare save string round-trip
    let rtSave = null;
    try {
      rtSave = TrackData.fromSaveString(newSave);
    } catch (e) {
      reasons.push(`save: decode threw: ${e.message}`);
    }
    if (rtSave == null) {
      reasons.push("save: decode returned null");
    } else {
      const cmp = deepCompareTracks(td, rtSave);
      if (cmp) reasons.push("save: " + cmp);
    }

    // Compare export string round-trip (with metadata)
    let rtExport = null, rtExportMeta = null;
    try {
      const r = TrackData.fromExportString(newExport);
      rtExport = r?.trackData ?? null;
      rtExportMeta = r?.trackMetadata ?? null;
    } catch (e) {
      reasons.push(`export: decode threw: ${e.message}`);
    }
    if (rtExport == null) {
      reasons.push("export: decode returned null");
    } else {
      const cmp = deepCompareTracks(td, rtExport);
      if (cmp) reasons.push("export: " + cmp);
      if (rtExportMeta) {
        if (rtExportMeta.name !== exportMeta.name) {
          reasons.push(`export meta name: '${rtExportMeta.name}' vs '${exportMeta.name}'`);
        }
        if (rtExportMeta.author !== exportMeta.author) {
          reasons.push(`export meta author: '${rtExportMeta.author}' vs '${exportMeta.author}'`);
        }
        const tA = exportMeta.lastModified instanceof Date ? exportMeta.lastModified.getTime() : null;
        const tB = rtExportMeta.lastModified instanceof Date ? rtExportMeta.lastModified.getTime() : null;
        if (tA !== tB) reasons.push(`export meta lastModified: ${tA} vs ${tB}`);
      }
    }

    // Verify the algorithm is deterministic / idempotent
    if (rtSave) {
      const a = td.betterCodes.toByteArray();
      const b = rtSave.betterCodes.toByteArray();
      if (a.length !== b.length) {
        reasons.push(`idempotency: length ${a.length} vs ${b.length}`);
      } else {
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) {
            reasons.push(`idempotency: byte ${i} differs (${a[i]} vs ${b[i]})`);
            break;
          }
        }
      }
    }

    if (reasons.length) {
      failed.push({ idx, name, parts: td.numberOfParts, reasons });
      continue;
    }

    // Record size metrics for the kind matching the input (save or export)
    const newStr = kind === "save" ? newSave : newExport;
    const rawNew = td.betterCodes.toByteArray().length;
    const parts = td.numberOfParts;

    results.push({
      idx,
      name,
      kind,
      parts,
      oldLen: input.length,
      newLen: newStr.length,
      newRawBytes: rawNew,
      bytesPerPart: parts > 0 ? +(rawNew / parts).toFixed(2) : 0,
      saved: input.length - newStr.length,
      pctGain: +((1 - newStr.length / input.length) * 100).toFixed(1),
    });
  }

  console.table(results);

  if (!results.length) {
    console.warn("No successful runs.");
    if (failed.length) console.warn("Failed:", failed);
    if (skipped.length) console.warn("Skipped:", skipped);
    return { results, failed, skipped };
  }

  const totalOld = results.reduce((s, r) => s + r.oldLen, 0);
  const totalNew = results.reduce((s, r) => s + r.newLen, 0);
  const totalParts = results.reduce((s, r) => s + r.parts, 0);
  const totalRawNew = results.reduce((s, r) => s + r.newRawBytes, 0);

  const pcts = results.map(r => r.pctGain).sort((a, b) => a - b);
  const pct = p => pcts[Math.min(pcts.length - 1, Math.floor(pcts.length * p))];

  console.log(
    `\n===== summary across ${results.length} track codes =====\n` +
    `total old chars: ${totalOld}\n` +
    `total new chars: ${totalNew}  (${((1 - totalNew / totalOld) * 100).toFixed(1)}% smaller)\n` +
    `per-track reduction:  min ${pcts[0]}%  p25 ${pct(0.25)}%  median ${pct(0.5)}%  p75 ${pct(0.75)}%  max ${pcts.at(-1)}%\n` +
    `total parts: ${totalParts}\n` +
    `avg new raw bytes/part: ${(totalRawNew / totalParts).toFixed(2)}\n` +
    `verification: ${results.length}/${results.length + failed.length} passed`
  );

  if (failed.length) console.warn(`${failed.length} failed:`, failed);
  if (skipped.length) console.warn(`${skipped.length} skipped:`, skipped);

  return { results, failed, skipped };
}

// Grabs all v5 track codes from localStorage
function grabLocalStorageTracks() {
  const prefix = "polytrack_v5_prod_track_";
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (typeof parsed?.data === "string") {
        out.push({ name: key.slice(prefix.length), data: parsed.data });
      }
    } catch { }
  }
  return out;
}