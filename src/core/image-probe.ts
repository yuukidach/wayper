import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageDimensions {
  width: number;
  height: number;
  format: ImageFormat;
}

const WINDOWS_REPLACE_ATTEMPTS = 5;
const WINDOWS_REPLACE_RETRY_MS = 25;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

export function atomicWrite(filePath: string, data: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const rand = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(dir, `.${base}.${rand}.tmp`);
  let fd: number | null = null;

  try {
    fd = fs.openSync(tmpPath, "wx");
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    const attempts = process.platform === "win32" ? WINDOWS_REPLACE_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (error) {
        if (attempt + 1 >= attempts || !isTransientRenameError(error)) {
          throw error;
        }
        sleepSync(WINDOWS_REPLACE_RETRY_MS * (attempt + 1));
      }
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failure on cleanup
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore missing temp file
    }
  }
}

function readExact(fd: number, buffer: Buffer, offset: number, length: number, position: number): boolean {
  let total = 0;
  while (total < length) {
    const bytesRead = fs.readSync(fd, buffer, offset + total, length - total, position + total);
    if (bytesRead <= 0) {
      return false;
    }
    total += bytesRead;
  }
  return true;
}

function isPngSignature(header: Buffer): boolean {
  return (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  );
}

function probePng(fd: number, fileSize: number): ImageDimensions | null {
  if (fileSize < 24) return null;
  const buf = Buffer.allocUnsafe(24);
  if (!readExact(fd, buf, 0, 24, 0)) return null;
  if (!isPngSignature(buf)) return null;

  const ihdrLen = buf.readUInt32BE(8);
  const chunkType = buf.toString("ascii", 12, 16);
  if (chunkType !== "IHDR" || ihdrLen < 13) return null;

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height, format: "png" };
}

function isJpegSofMarker(marker: number): boolean {
  return (
    marker === 0xc0 || // SOF0 (Baseline DCT)
    marker === 0xc1 || // SOF1 (Extended sequential DCT)
    marker === 0xc2 || // SOF2 (Progressive DCT)
    marker === 0xc3 || // SOF3 (Lossless)
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}

function probeJpeg(fd: number, fileSize: number): ImageDimensions | null {
  if (fileSize < 4) return null;
  const scratch = Buffer.allocUnsafe(16);
  let pos = 2; // After 0xFF 0xD8

  while (pos < fileSize) {
    if (!readExact(fd, scratch, 0, 1, pos)) return null;
    pos += 1;
    if (scratch[0] !== 0xff) {
      return null;
    }

    let marker = 0xff;
    while (marker === 0xff) {
      if (pos >= fileSize || !readExact(fd, scratch, 0, 1, pos)) {
        return null;
      }
      marker = scratch[0];
      pos += 1;
    }

    if (marker === 0x00 || marker === 0xd8) {
      return null;
    }
    // EOI or SOS encountered before SOFn
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    // Standalone markers without segment length (TEM, RST0..RST7)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (pos + 2 > fileSize || !readExact(fd, scratch, 0, 2, pos)) {
      return null;
    }
    const segmentLength = scratch.readUInt16BE(0);
    if (segmentLength < 2 || pos + segmentLength > fileSize) {
      return null;
    }

    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7) return null;
      if (!readExact(fd, scratch, 0, 5, pos + 2)) return null;
      const height = scratch.readUInt16BE(1);
      const width = scratch.readUInt16BE(3);
      if (width <= 0 || height <= 0) return null;
      return { width, height, format: "jpeg" };
    }

    pos += segmentLength;
  }

  return null;
}

function probeWebp(fd: number, fileSize: number): ImageDimensions | null {
  if (fileSize < 20) return null;
  const chunkHeader = Buffer.allocUnsafe(8);
  const payload = Buffer.allocUnsafe(10);
  let pos = 12; // After "RIFF" + size + "WEBP"

  while (pos + 8 <= fileSize) {
    if (!readExact(fd, chunkHeader, 0, 8, pos)) return null;
    const fourCC = chunkHeader.toString("ascii", 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);
    const dataPos = pos + 8;
    if (dataPos + chunkSize > fileSize) return null;

    if (fourCC === "VP8 ") {
      if (chunkSize < 10 || !readExact(fd, payload, 0, 10, dataPos)) return null;
      // Keyframe bit (bit 0 of first byte must be 0) + VP8 start code 0x9d 0x01 0x2a
      if ((payload[0] & 0x01) !== 0) return null;
      if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return null;
      const width = payload.readUInt16LE(6) & 0x3fff;
      const height = payload.readUInt16LE(8) & 0x3fff;
      if (width <= 0 || height <= 0) return null;
      return { width, height, format: "webp" };
    }

    if (fourCC === "VP8L") {
      if (chunkSize < 5 || !readExact(fd, payload, 0, 5, dataPos)) return null;
      if (payload[0] !== 0x2f) return null;
      const bits = payload.readUInt32LE(1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      if (width <= 0 || height <= 0) return null;
      return { width, height, format: "webp" };
    }

    if (fourCC === "VP8X") {
      if (chunkSize < 10 || !readExact(fd, payload, 0, 10, dataPos)) return null;
      const width = (payload[4] | (payload[5] << 8) | (payload[6] << 16)) + 1;
      const height = (payload[7] | (payload[8] << 8) | (payload[9] << 16)) + 1;
      if (width <= 0 || height <= 0) return null;
      return { width, height, format: "webp" };
    }

    const paddedSize = chunkSize + (chunkSize & 1);
    pos = dataPos + paddedSize;
  }

  return null;
}

export function probeImageDimensions(filePath: string): ImageDimensions | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) {
      return null;
    }
    fd = fs.openSync(filePath, "r");
    const magic = Buffer.allocUnsafe(12);
    const readCount = fs.readSync(fd, magic, 0, Math.min(12, stat.size), 0);
    if (readCount < 4) {
      return null;
    }

    if (readCount >= 8 && isPngSignature(magic)) {
      return probePng(fd, stat.size);
    }
    if (magic[0] === 0xff && magic[1] === 0xd8) {
      return probeJpeg(fd, stat.size);
    }
    if (
      readCount >= 12 &&
      magic.toString("ascii", 0, 4) === "RIFF" &&
      magic.toString("ascii", 8, 12) === "WEBP"
    ) {
      return probeWebp(fd, stat.size);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

export function validateImageFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return false;
    }
    const dims = probeImageDimensions(filePath);
    return dims !== null && dims.width > 0 && dims.height > 0;
  } catch {
    return false;
  }
}
