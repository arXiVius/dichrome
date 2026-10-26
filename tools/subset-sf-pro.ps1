# Subset berkas SF Pro Display OTF (dari tools/install-sf-pro.ps1) menjadi
# WOFF2 kecil untuk src/ui/fonts.css. Glif yang dipertahankan adalah SUPERSET
# dari semua karakter yang dipakai di src/ (Latin, Latin Extended-A, Yunani
# untuk Σ/λ, combining marks, General Punctuation, Number Forms ⅛-⅞, arrows,
# box drawing, ⌘/⇧, matematika dasar) — tampilan identik, hanya berkas lebih
# kecil (~2,3 MB -> ~50 KB per bobot). Butuh Python + fonttools + brotli:
#
#   python -m pip install fonttools brotli
#   powershell -ExecutionPolicy Bypass -File tools/subset-sf-pro.ps1
#
# Hasil: public/fonts/sf-pro/*.woff2 (4 bobot). OTF asli TIDAK dihapus —
# tetap jadi fallback di src/ui/fonts.css dan sumber untuk subsetting ulang.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $repo 'public\fonts\sf-pro'

# Superset aman per blok Unicode (lebih luas dari pemakaian src/ agar teks
# dinamis/taksi ke depan tidak pernah jatuh font lain).
$unicodes = @(
  'U+0020-007E'    # Basic Latin (tanda baca, angka, huruf)
  'U+00A0-00FF'    # Latin-1 Supplement (± × ° µ ¼ ½ ¾ § …)
  'U+0100-017F'    # Latin Extended-A (ā untuk "gammā", dll.)
  'U+0300-036F'    # Combining Diacritical Marks
  'U+0370-03FF'    # Greek and Coptic (γ Σ λ dll.)
  'U+2000-206F'    # General Punctuation (– — ’ “ ” … › • €)
  'U+2150-215F'    # Number Forms (⅛ ⅜ ⅝ ⅞)
  'U+2190-21FF'    # Arrows (← → ⇧ ⇥ dll.)
  'U+2212'         # − (minus)
  'U+221E'         # ∞
  'U+2248'         # ≈
  'U+2265'         # ≥
  'U+22EF'         # ⋯
  'U+2300-23FF'    # Miscellaneous Technical (⌘ ⌥ dll.)
  'U+2500-257F'    # Box Drawing (─ ═ log monospace)
) -join ','

foreach ($w in 'Regular', 'Medium', 'Semibold', 'Bold') {
  $in = Join-Path $dir "SF-Pro-Display-$w.otf"
  if (-not (Test-Path $in)) { throw "Tidak ada $in — jalankan tools/install-sf-pro.ps1 dulu." }
  $out = Join-Path $dir "SF-Pro-Display-$w.subset.woff2"
  & python -m fontTools.subset $in --unicodes=$unicodes --layout-features='*' --flavor=woff2 --output-file=$out
  if ($LASTEXITCODE -ne 0) { throw "pyftsubset gagal untuk $w." }
  $kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
  Write-Host ("{0}: {1} KB" -f (Split-Path $out -Leaf), $kb)
}
Write-Host 'Selesai. Perbarui src/ui/fonts.css bila nama berkas berubah.'
