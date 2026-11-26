/**
 * 优先使用平台配置的图片；CI 无法下载时使用仓库资源或内置图片。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './ensure-bundled-assets.mjs';
import { isPngImage } from './lib/png-image.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'resources');
const bundledDir = path.join(assetsDir, 'bundled');
fs.mkdirSync(assetsDir, { recursive: true });

function isPrivateHost(url) {
  try {
    const { hostname } = new URL(url);
    const h = hostname.toLowerCase();
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)$/i.test(h)) return true;
    if (h === 'xh.ms' || h.endsWith('.xh.ms')) return true;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

function copyBundled(name) {
  const src = path.join(bundledDir, name);
  const dest = path.join(assetsDir, name);
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  console.log(`download-assets: bundled fallback ${name}`);
  return true;
}

function absUrl(base, rel) {
  const u = String(rel || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const b = String(base || '').replace(/\/$/, '');
  if (!b) return u;
  return `${b}${u.startsWith('/') ? u : `/${u}`}`;
}

const convertToPng = `
import io
import sys
from PIL import Image, ImageOps

with Image.open(io.BytesIO(sys.stdin.buffer.read())) as image:
    ImageOps.exif_transpose(image).convert("RGBA").save(sys.stdout.buffer, format="PNG")
`;

async function download(label, url, name, minimumSize = 2) {
  if (!url || isPrivateHost(url)) return false;
  const dest = path.join(assetsDir, name);
  const staged = path.join(assetsDir, `.${name}.${randomUUID()}.tmp`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      console.warn(`download-assets: FAIL ${url} HTTP ${res.status}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) {
      console.warn(`download-assets: FAIL ${url} too small (${buf.length} bytes)`);
      return false;
    }
    fs.writeFileSync(staged, buf);
    if (!isPngImage(staged, minimumSize, minimumSize)) {
      const converted = spawnSync(process.env.PYTHON_BIN || 'python3', ['-c', convertToPng], {
        input: buf,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (converted.status !== 0) {
        throw new Error(converted.error?.message || converted.stderr.toString().trim() || 'PNG conversion failed');
      }
      fs.writeFileSync(staged, converted.stdout);
    }
    if (!isPngImage(staged, minimumSize, minimumSize)) {
      throw new Error(`image must be at least ${minimumSize}x${minimumSize} pixels`);
    }
    fs.renameSync(staged, dest);
    console.log(`download-assets: OK ${label} (${fs.statSync(dest).size} PNG bytes) <- ${url}`);
    return true;
  } catch (e) {
    console.warn(`download-assets: FAIL ${url}`, e.message);
    return false;
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function useRepoAsset(name, minimumSize = 2) {
  const dest = path.join(assetsDir, name);
  if (isPngImage(dest, minimumSize, minimumSize)) {
    console.log(`download-assets: use repo resources/${name} (${fs.statSync(dest).size} bytes)`);
    return true;
  }
  return false;
}

const platform = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
const skipRemote = !platform || isPrivateHost(platform);
const iconUrl = skipRemote ? '' : absUrl(platform, process.env.ICON_URL);
const splashUrl = skipRemote ? '' : absUrl(platform, process.env.SPLASH_URL);
const squareUrl = skipRemote ? '' : absUrl(platform, process.env.SQUARE_ICON_URL);

if (skipRemote) {
  console.log('download-assets: skip remote (local/private PLATFORM_URL), prefer repo resources/');
}

const splashEnabled = process.env.SPLASH_ENABLED !== 'false';
let iconOk = await download('icon', iconUrl, 'icon.png', 48) || useRepoAsset('icon.png', 48);
if (!iconOk) {
  iconOk = await download('icon-from-square', squareUrl, 'icon.png', 48);
}
let squareOk = await download('square-icon', squareUrl, 'square-icon.png', 48) || useRepoAsset('square-icon.png', 48);
let splashOk = false;
if (splashEnabled) {
  splashOk = await download('splash', splashUrl, 'splash.png') || useRepoAsset('splash.png');
}

if (!iconOk) iconOk = copyBundled('icon.png') || copyBundled('square-icon.png');
if (splashEnabled && !splashOk) splashOk = copyBundled('splash.png');
if (!squareOk && !fs.existsSync(path.join(assetsDir, 'square-icon.png'))) {
  squareOk = copyBundled('square-icon.png');
}

if (!iconOk) console.warn('download-assets: no launcher icon');
if (splashEnabled && !splashOk) console.warn('download-assets: no splash');
