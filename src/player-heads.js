import sharp from 'sharp';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { limitedResponse } from './player-tracking.js';

export const GENERIC_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 8 8"><path fill="#6f8b69" d="M0 0h8v8H0z"/><path fill="#b8cfa1" d="M1 1h6v5H1z"/><path fill="#253c32" d="M2 3h1v1H2zm3 0h1v1H5zM3 5h2v1H3z"/></svg>';

export function createHeadCache(directory, fetcher = fetch, now = Date.now) {
  const pending = new Map(), retryAfter = new Map();
  let active = 0;
  const waiting = [];
  return async uuid => {
    if (!/^[a-f0-9]{32}$/.test(uuid)) throw new Error('Invalid player UUID.');
    if (pending.has(uuid)) return pending.get(uuid);
    const job = (async () => {
      const file = path.join(directory, `${uuid}.png`);
      let cached;
      try {
        cached = await readFile(file);
        if (now() - (await stat(file)).mtimeMs < 86400000) return cached;
      } catch {}
      if ((retryAfter.get(uuid) ?? 0) > now()) return cached ?? null;
      if (active >= 4) await new Promise(resolve => waiting.push(resolve));
      else active++;
      try {
        const request = async (url, limit) => limitedResponse(await fetcher(url, { signal: AbortSignal.timeout(5000), redirect: 'error' }), limit);
        const profile = JSON.parse(await request(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, 65536));
        const property = profile.properties?.find(item => item.name === 'textures');
        const texture = JSON.parse(Buffer.from(property?.value ?? '', 'base64').toString('utf8'))?.textures?.SKIN?.url;
        const url = new URL(texture);
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || !/^\/texture\/[a-f0-9]+$/i.test(url.pathname) || url.search || url.port || url.username || url.password) throw new Error('Invalid Minecraft texture URL.');
        url.protocol = 'https:';
        const skin = await request(url.href, 1024 * 1024);
        const metadata = await sharp(skin, { limitInputPixels: 65536 }).metadata();
        if (metadata.width !== 64 || ![32, 64].includes(metadata.height)) throw new Error('Unsupported skin dimensions.');
        const face = await sharp(skin).extract({ left: 8, top: 8, width: 8, height: 8 }).png().toBuffer();
        const hat = await sharp(skin).extract({ left: 40, top: 8, width: 8, height: 8 }).png().toBuffer();
        const combined = await sharp(face).composite([{ input: hat }]).png().toBuffer();
        const head = await sharp(combined).resize(32, 32, { kernel: 'nearest' }).png().toBuffer();
        await mkdir(directory, { recursive: true });
        await writeFile(`${file}.tmp`, head); await rename(`${file}.tmp`, file);
        retryAfter.delete(uuid); return head;
      } catch {
        if (retryAfter.size > 1000) retryAfter.clear();
        retryAfter.set(uuid, now() + 60000);
        return cached ?? null;
      } finally {
        const next = waiting.shift();
        if (next) next(); else active--;
      }
    })();
    pending.set(uuid, job);
    try { return await job; } finally { pending.delete(uuid); }
  };
}
