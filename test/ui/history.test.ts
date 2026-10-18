import { describe, expect, it } from 'vitest';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import { cropText, describeChange, describeStep } from '../../src/ui/model/history';
import { identityCrop } from '../../src/io/geometry';

const base = BASELINE_RENDER_PARAMS;

describe('describeChange (riwayat Undo)', () => {
  it('names the tool and its new value', () => {
    expect(describeChange(base, { ...base, printExposureEv: 0.5 })).toEqual({ label: 'Exposure', value: '−0.5 EV' });
  });

  it('names film and paper by stock', () => {
    expect(describeChange(base, { ...base, film: 'kodak_portra_800' })).toEqual({ label: 'Film', value: 'Portra 800' });
    expect(describeChange(base, { ...base, filmEnabled: false })).toEqual({ label: 'Film', value: 'Off' });
    expect(describeChange(base, { ...base, paper: 'kodak_2383' }).label).toBe('Paper');
  });

  it('groups white balance fields into one tool', () => {
    const r = describeChange(base, { ...base, cameraWhiteBalanceK: 6500, cameraTint: 0.2 });
    expect(r.label).toBe('White Balance');
  });

  it('lists several tools without a single value', () => {
    const r = describeChange(base, { ...base, printExposureEv: 0.5, film: 'kodak_portra_800', paper: 'kodak_2383' });
    expect(r.value).toBeUndefined();
    expect(r.label).toMatch(/\+1$/);
  });
});

describe('describeStep (crop di riwayat Undo)', () => {
  const crop = { ...identityCrop(0.75), aspect: '4:5', angle: 2.4 };
  it('labels a crop-only step as Crop with its value', () => {
    expect(describeStep({ params: base }, { params: base, crop })).toEqual({ label: 'Crop', value: '4:5 · 2.4°' });
    expect(describeStep({ params: base, crop }, { params: base })).toEqual({ label: 'Crop', value: 'Off' });
  });
  it('falls back to the recipe change otherwise', () => {
    expect(describeStep({ params: base, crop }, { params: { ...base, printExposureEv: 0.5 }, crop }).label).toBe('Exposure');
  });
  it('describes rotate and flip', () => {
    expect(cropText({ ...identityCrop(1), quarter: 1, flip: true })).toBe('Free · 90° · Flipped');
  });
});
