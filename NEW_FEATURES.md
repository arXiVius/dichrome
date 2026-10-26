# Palma — New Feature Ideas

This file records feature ideas beyond the current scope, organized by area.
Each entry includes a short description, target audience, and rough priority.
None of these are committed work; they are a backlog for future phases.

*Rebranded from DICHROIC to Palma — 2026-10-26*

## Film Stock & Profile Features

### Custom Film Stock Creator
Let users define or import spectral response curves and save them as custom stocks
alongside the built-in catalog. Includes curve editors for density, hue, and
response, plus import/export of stock definitions as JSON.

- Audience: Film enthusiasts, advanced colorists
- Priority: Medium
- Depends on: Existing stock/profile loading (`src/profiles/load.ts`)

### Stock Matching
Upload a reference photo; the app analyzes its spectral/color characteristics and
suggests the closest film stock plus starting parameters (exposure, push/pull,
filters).

- Audience: Film enthusiasts who want guidance
- Priority: High
- Depends on: Spectral analysis hooks, existing film catalog

### Push/Pull Custom Curves
Custom push/pull processing curves beyond the standard ± stops, with user-definable
density shifts per stop.

- Audience: Advanced colorists
- Priority: Low

### Cross-Processing Simulation
Simulate developing film in "wrong" chemistry (e.g., E-6 in C-41) with characteristic
color shifts and contrast changes.

- Audience: Creative/experimental users
- Priority: Low

### Expired Film Simulation
Fog, dye shift, and increased grain base controlled by age/temperature parameters.

- Audience: Creative users
- Priority: Low

### IR / False-Color Film
Simulate infrared or false-color film response by remapping spectral channels.

- Audience: Creative users
- Priority: Low

### Print Surface Texture
Glossy/matte/luster paper surface texture applied in scan/print modes, with
physical grain scaling per paper type.

- Audience: Print photographers
- Priority: Low

## Workflow & Productivity

### Batch Processing
Apply the same film + parameters to a folder of photos, with an export queue and
per-photo overrides.

- Audience: Working photographers
- Priority: High
- Depends on: Existing Session worker, export pipeline

### Presets
Save/load full parameter sets as `.dichroic-preset` files (JSON + optional
thumbnail). Share and import presets between users/devices.

- Audience: All users
- Priority: High

### Contact Sheets
Generate print contact sheets with multiple images, rebate edge markings, frame
numbers, and film borders.

- Audience: Film photographers
- Priority: Medium

### DNG Export
Export processed results as DNG with embedded film simulation metadata (color
matrix, profile name, parameters).

- Audience: Photographers using other RAW tools downstream
- Priority: Low

### History Browser
Visual timeline of all edits with per-step before/after thumbnails, jump-to-any-
step, and branching variants.

- Audience: Advanced users
- Priority: Medium

### Compare Two Photos
Side-by-side comparison of two different photos (not just before/after of the
same photo), with linked zoom/pan.

- Audience: Photographers choosing between shots
- Priority: Medium

## Color & Analysis Tools

### Color Checker Calibration
Photograph a ColorChecker; derive the input color matrix and white balance from
the captured patches, then apply to subsequent photos.

- Audience: Color-critical photographers
- Priority: Medium
- Depends on: Input color space pipeline (`src/host/colorDecode.ts`)

### Negativoscope View
Inverted negative view with orange-mask simulation for evaluating negatives on a
light table.

- Audience: Film photographers
- Priority: Low

### ICC Inspector
View and edit embedded ICC profiles on import/export; warn on profile mismatches.

- Audience: Advanced users
- Priority: Low

### Clipping / Zebra Warnings
Real-time highlight and shadow clipping indicators (zebra stripes) on the photo
preview, tied to the histogram.

- Audience: All photographers
- Priority: High

## UX / Interface (Immediate Candidates)

### Split Before/After View
Vertical/horizontal draggable divider showing the original on one side and the
graded result on the other, at full resolution, with linked zoom/pan. Complements
the existing hold-to-peek toggle.

- Priority: High
- File: `src/ui/components/PhotoView.tsx`, `src/ui/components/ImageCompare.tsx`

### Film Format Presets with Physical Grain Scaling
Explicit format presets (35 mm, 120 6×6, 4×5, etc.) with physical grain size in
microns, so grain scales correctly regardless of output resolution. Optional
rebate edge markings and sprocket-hole contact-sheet looks.

- Priority: Medium
- Files: `src/params/filmFormat.ts`, `src/params/renderParams.ts`, UI film controls

### Focus Peaking
Edge-highlight filter (high-pass on luma) toggleable in the camera viewfinder for
manual focus assist.

- Priority: Low/Medium
- File: Camera screen (`src/ui/screens/Camera.tsx`)

### Depth Map Visualization & Editing
False-color or grayscale depth-map preview toggle, plus a brush to manually edit
depth values for lens-blur control.

- Priority: Medium
- Depends on: Existing depth pipeline (`src/depth/`)

### Local Adjustment Brushes (Dodge/Burn)
Brush-based exposure/contrast/saturation local adjustments with feathered masks,
rendered as an additional stage before film simulation.

- Priority: Medium/High
- Depends on: Retouch/patch infrastructure (`src/retouch/`)

### Gradient Filters (ND Grad, Color Grad)
Linear/radial gradient overlays for exposure and color temperature, simulated as
physical filter effects before the film pipeline.

- Priority: Medium

## Performance & Architecture

### WASM Port of Host-Side Spectral Math
Port `src/host/spectral.ts` (~1,270 lines of CPU TypeScript: spectral upsampling,
DIR couplers, print LUT baking) to Rust/WASM called from the Session worker.
Keep the TS version as the parity reference.

- Priority: Medium
- Impact: Preview responsiveness on mobile

### Incremental Stage Caching for Slider Interactions
Dirty-tracking cache at the render-graph stage level: when only a downstream
parameter (e.g., `printExposureEv`) changes, skip upstream stages and reuse their
GPU buffer outputs.

- Status: Implemented; checkpoints bounded to 8 stages / 128 MiB per graph
  (2026-10-25, so a large preview cannot retain hundreds of MB of full-frame
  GPU buffers). The checkpoint memory is the remaining trade-off between VRAM
  and how much of the chain a downstream change skips.
- Priority: High
- Impact: 60 fps slider editing
- File: `src/engine/graph.ts`

### Bundle Size & Precache Optimization
Code-split screens and shaders so the initial load includes only the Start screen
and core engine. Lazy-load Editor, Export, Camera, and depth/retouch workers on
first use.

- Priority: Medium
- Impact: Faster first paint on slow networks
- File: `src/ui/App.tsx`, `src/ui/screens/Editor.tsx`, `vite.config.ts`

### WebGL 2 Fallback Path
Reduced-precision preview renderer (RGB, no FFT diffusion/lens blur) for browsers
without WebGPU, so users can at least load and export on unsupported hardware.

- Priority: Medium
- Impact: Expanded browser/device support

### Memory-Mapped / Streaming Decode for Large Images
Stream decode in strips and keep the source in a chunked buffer, only boxing the
active tile region for the GPU. Addresses 24/48 MP photo memory risk on mobile.

- Priority: High
- Files: `src/io/`, `src/session/`

## Platform (Documented as Outstanding)

- Physical iPhone / Safari testing (WebGPU on iOS 26+)
- Capacitor iOS app wrapper (noted as planned in README.md)
- Multi-browser offline / service-worker update testing
- Native heap / GPU memory benchmarking on low-memory devices