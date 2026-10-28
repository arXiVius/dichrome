# Palma — New Features

## Version 0.1.0

### Camera Interface Overhaul
- **Rangefinder-style camera design** (Phase 1): Colorized film canister window, crisp click buttons, 36-frame roll counter, horizontal EV dial, shutter curtain, and WB/ISO/EV data display in the viewfinder window
- **Physical lens selection**: Choose from 13mm, 24mm, and 77mm lenses (with 23mm front element); active blue lens without digital zoom wrapper
- **Exposure controls**: Tap to set point, drag up/down to adjust EV; WB and ISO now follow captured results
- **Perfect circular buttons** on iPhone: Fixed 80/66px dimensions (not aspect-ratio dependent)

### User Interface Polish
- **Symmetric camera plate**: Balanced design between buttons with equal spacing
- **Rangefinder aesthetics**: Brackets at consistent width and distance; last photo and EV/SS display as mirrors
- **Enlarged controls**: Camera window 3:4 ratio; controls larger (jepret 75-88px, bracket 132px, text 14/19px) centered at bottom

### Technical Improvements
- **Depth Pro integration**: Mobile lens blur model without FOV head, split into image/patch/decoder ONNX sessions
- **WebGPU renderer**: Dawn backend via webgpu package, TypeScript 5.7, Vitest 2
- **Python fixture pipeline**: `.venv-ref` for new fixtures, fast Gaussian filter support
- **CoAP/COEP/CORP headers**: All responses configured for RAW playback on GitHub Pages

### Phase 2 Features
- **Batch parameter diffusion**: FFT-based diffusion parameters
- **IO pipeline**: JPEG-PNG-EXR-TIFF workflow support
- **Production regime**: Resolve-grade implementation planning

---
*Last updated: 2026-10-26 — Rebranded from DICHROIC to Palma*