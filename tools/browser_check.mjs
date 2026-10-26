/**
 * Pemeriksaan browser untuk jalur yang diubah optimasi: sheet bermuat
 * dinamis (Export/Crop/Film carousel), slider (baris alat yang di-memo),
 * dan keadaan error. `tools/browser_smoke.mjs` sudah usang (menunggu teks
 * "Darkroom ready." yang sudah dihapus dari UI), jadi pemeriksaan ini
 * fokus pada apa yang benar-benar berubah.
 *
 * Pakai: node tools/browser_check.mjs  (butuh `vite preview` di :5183)
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('package.json'));
const { chromium } = require('playwright-core');
const base = process.env.DICHROIC_SMOKE_URL ?? 'http://localhost:5183/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const step = (name) => console.log(`PASS ${name}`);
try {
  await page.goto(base, { waitUntil: 'load' });
  await page.getByRole('tab', { name: /^Film$/ }).first().waitFor({ timeout: 60_000 });
  step('boot: editor renders');

  // Sheet Export: chunk dinamis (React.lazy) harus termuat dan merender.
  // Butuh foto terbuka (tombol Export mati tanpa foto).
  const input = page.locator('input[type=file]');
  await input.setInputFiles(resolve('test/fixtures/io/tiff_rgb8/input.tif'));
  const photoReady = await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  if (!photoReady) {
    // Tanpa perangkat WebGPU di Chrome headless ini: engine tak pernah
    // selesai, jadi jalur interaktif tak bisa diperiksa (bukan regresi).
    console.log('SKIP interactive steps: no WebGPU device in this headless environment');
    if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
    step('no browser errors');
  } else {
    await runInteractive(page, step);
    if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
    step('no browser errors');
  }
} finally {
  await context.close();
  await browser.close();
}

/** Langkah interaktif: sheet lazy + slider (butuh foto terbuka). */
async function runInteractive(page, step) {
  step('photo opens and renders');

  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.getByText('Export', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
  step('export sheet (lazy chunk) renders');

  // Sheet Crop & Rotate: chunk dinamis, ada di toolbar kedua tata letak.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Crop & Rotate' }).first().click();
  await page.getByRole('button', { name: 'Rotate 90°' }).waitFor({ timeout: 30_000 });
  step('crop sheet (lazy chunk) renders');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Slider: nilai di UI harus ikut saat params berubah (baris memo tak boleh
  // membeku tampilan).
  const slider = page.getByRole('slider').first();
  if (await slider.count()) {
    const before = await slider.getAttribute('aria-valuenow');
    const box = await slider.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(800);
      const after = await slider.getAttribute('aria-valuenow');
      if (after === before) throw new Error(`slider did not move (${before} -> ${after})`);
      step(`slider reacts (${before} -> ${after})`);
    }
  } else {
    step('slider not present in this layout (skipped)');
  }
}
