export type EncodedOutputFormat = "png" | "jpeg";

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_CHUNK_LENGTH = 256 * 1024 * 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

function byteAt(bytes: Uint8Array, index: number) {
  return bytes[index] ?? -1;
}

function crc32(bytes: Uint8Array, start: number, length: number) {
  let crc = 0xffffffff;
  for (let offset = start; offset < start + length; offset++) {
    crc = (CRC32_TABLE[(crc ^ byteAt(bytes, offset)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkTypeAt(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(
    byteAt(bytes, offset),
    byteAt(bytes, offset + 1),
    byteAt(bytes, offset + 2),
    byteAt(bytes, offset + 3)
  );
}

export function validatePngStructure(bytes: Uint8Array): ValidationResult {
  if (bytes.byteLength < 57) {
    return fail("too-small");
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (byteAt(bytes, index) !== PNG_SIGNATURE[index]) {
      return fail("bad-signature");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, false);
    if (chunkLength > MAX_PNG_CHUNK_LENGTH) {
      return fail("chunk-too-large");
    }

    const chunkTypeOffset = offset + 4;
    const chunkDataOffset = offset + 8;
    const crcOffset = chunkDataOffset + chunkLength;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.byteLength) {
      return fail("truncated-chunk");
    }

    const chunkType = chunkTypeAt(bytes, chunkTypeOffset);
    if (!/^[A-Za-z]{4}$/.test(chunkType)) {
      return fail("invalid-chunk-type");
    }

    const expectedCrc = view.getUint32(crcOffset, false);
    const actualCrc = crc32(bytes, chunkTypeOffset, 4 + chunkLength);
    if (actualCrc !== expectedCrc) {
      return fail(`crc-mismatch-${chunkType}`);
    }

    if (!sawIHDR && chunkType !== "IHDR") {
      return fail("first-chunk-not-IHDR");
    }
    if (chunkType === "IHDR") {
      if (sawIHDR) {
        return fail("duplicate-IHDR");
      }
      if (chunkLength !== 13) {
        return fail("IHDR-wrong-length");
      }
      const width = view.getUint32(chunkDataOffset, false);
      const height = view.getUint32(chunkDataOffset + 4, false);
      if (width === 0 || height === 0) {
        return fail("zero-dimensions");
      }
      sawIHDR = true;
    } else if (chunkType === "IDAT") {
      if (!sawIHDR) {
        return fail("IDAT-before-IHDR");
      }
      if (chunkLength > 0) {
        sawIDAT = true;
      }
    } else if (chunkType === "IEND") {
      if (chunkLength !== 0) {
        return fail("IEND-wrong-length");
      }
      if (!sawIDAT) {
        return fail("missing-or-empty-IDAT");
      }
      sawIEND = true;
      offset = nextOffset;
      break;
    }

    offset = nextOffset;
  }

  if (!sawIHDR) {
    return fail("missing-IHDR");
  }
  if (!sawIDAT) {
    return fail("missing-or-empty-IDAT");
  }
  if (!sawIEND) {
    return fail("missing-IEND");
  }
  if (offset !== bytes.byteLength) {
    return fail("trailing-data");
  }
  return { ok: true };
}

function isJpegStartOfFrame(marker: number) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function isJpegRestartMarker(marker: number) {
  return marker >= 0xd0 && marker <= 0xd7;
}

function readUint16(bytes: Uint8Array, offset: number) {
  return ((byteAt(bytes, offset) & 0xff) << 8) | (byteAt(bytes, offset + 1) & 0xff);
}

export function validateJpegStructure(bytes: Uint8Array): ValidationResult {
  if (bytes.byteLength < 4) {
    return fail("too-small");
  }
  if (byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== 0xd8) {
    return fail("bad-SOI");
  }

  let offset = 2;
  let sawSOF = false;
  let sawSOS = false;
  let sawEOI = false;

  while (offset < bytes.byteLength) {
    if (byteAt(bytes, offset) !== 0xff) {
      return fail("marker-misalign");
    }
    while (offset < bytes.byteLength && byteAt(bytes, offset) === 0xff) {
      offset++;
    }
    if (offset >= bytes.byteLength) {
      return fail("truncated-marker");
    }

    const marker = byteAt(bytes, offset);
    offset++;

    if (marker === 0x00) {
      return fail("stuffed-marker-outside-scan");
    }
    if (marker === 0xd9) {
      sawEOI = true;
      if (offset !== bytes.byteLength) {
        return fail("trailing-data");
      }
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || isJpegRestartMarker(marker)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      return fail("truncated-segment");
    }

    const segmentLength = readUint16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return fail("bad-segment-length");
    }

    const segmentDataOffset = offset + 2;
    const segmentDataLength = segmentLength - 2;
    if (isJpegStartOfFrame(marker)) {
      if (segmentDataLength < 6) {
        return fail("bad-SOF");
      }
      const height = readUint16(bytes, segmentDataOffset + 1);
      const width = readUint16(bytes, segmentDataOffset + 3);
      const componentCount = byteAt(bytes, segmentDataOffset + 5);
      if (width <= 0 || height <= 0 || componentCount <= 0) {
        return fail("bad-SOF-dimensions");
      }
      if (segmentDataLength < 6 + componentCount * 3) {
        return fail("truncated-SOF");
      }
      sawSOF = true;
    }

    if (marker === 0xda) {
      if (segmentDataLength < 4) {
        return fail("bad-SOS");
      }
      const componentCount = byteAt(bytes, segmentDataOffset);
      const expectedLength = 1 + componentCount * 2 + 3;
      if (componentCount <= 0 || segmentDataLength < expectedLength) {
        return fail("truncated-SOS");
      }
      sawSOS = true;
      offset += segmentLength;
      while (offset < bytes.byteLength) {
        if (byteAt(bytes, offset) === 0xff) {
          const next = byteAt(bytes, offset + 1);
          if (next === 0x00) {
            offset += 2;
            continue;
          }
          if (isJpegRestartMarker(next)) {
            offset += 2;
            continue;
          }
          break;
        }
        offset++;
      }
      continue;
    }

    offset += segmentLength;
  }

  if (!sawSOF) {
    return fail("missing-SOF");
  }
  if (!sawSOS) {
    return fail("missing-SOS");
  }
  if (!sawEOI) {
    return fail("missing-EOI");
  }
  return { ok: true };
}

export function toOutputBytes(output: ArrayBuffer | Uint8Array | Uint8ClampedArray) {
  if (output instanceof Uint8Array && !(output instanceof Uint8ClampedArray)) {
    return output;
  }
  if (output instanceof Uint8ClampedArray) {
    const copy = new Uint8Array(output.byteLength);
    copy.set(output);
    return copy;
  }
  return new Uint8Array(output);
}

export function validateEncodedOutputFormat(format: EncodedOutputFormat, output: ArrayBuffer | Uint8Array | Uint8ClampedArray) {
  const bytes = toOutputBytes(output);
  if (bytes.byteLength === 0) {
    throw new Error("Invalid compressed output: empty worker result");
  }
  const result = format === "png" ? validatePngStructure(bytes) : validateJpegStructure(bytes);
  if (!result.ok) {
    throw new Error(`Invalid compressed output: ${format.toUpperCase()} ${result.reason}`);
  }
}
