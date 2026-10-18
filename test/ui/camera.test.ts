import { describe, expect, it } from 'vitest';
import { lensesFromDevices } from '../../src/ui/camera/backend';

describe('lensesFromDevices (lensa kamera dari nama perangkat)', () => {
  it('maps iPhone camera names to focal lengths and skips virtual cameras', () => {
    const lenses = lensesFromDevices([
      { deviceId: 'f', label: 'Front Camera' },
      { deviceId: 't', label: 'Back Telephoto Camera' },
      { deviceId: 'triple', label: 'Back Triple Camera' },
      { deviceId: 'u', label: 'Back Ultra Wide Camera' },
      { deviceId: 'w', label: 'Back Camera' },
      { deviceId: 'dual', label: 'Back Dual Wide Camera' },
    ]);
    expect(lenses.map((l) => `${l.facing}:${l.mm}:${l.deviceId}`)).toEqual(['back:13:u', 'back:24:w', 'back:77:t', 'front:23:f']);
  });

  it('falls back to one back lens when names are unknown or hidden', () => {
    expect(lensesFromDevices([{ deviceId: 'x', label: '' }]).map((l) => l.mm)).toEqual([24]);
  });
});

describe('exposureTables (EV dan WB dibakar ke jepretan)', () => {
  it('is neutral at 0 EV and auto white balance', async () => {
    const { exposureTables } = await import('../../src/ui/camera/backend');
    expect(exposureTables(0, [1, 1, 1])).toBeUndefined();
  });
  it('brightens by one stop in linear light and keeps black and white', async () => {
    const { exposureTables } = await import('../../src/ui/camera/backend');
    const [r] = exposureTables(1)!;
    expect(r[0]).toBe(0);
    expect(r[255]).toBe(255);
    // Tengah ter-encode 0,5 -> linear ~0,218 -> x2 -> ~0,686 ter-encode.
    expect(r[128]).toBeGreaterThan(170);
    expect(r[128]).toBeLessThan(180);
  });
});
