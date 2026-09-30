import math

# Metrology & Optical Nulling Mat v5.0
# Key Solutions Implemented:
# 1. Zero-Bleed Outward-Tangent Corner Targets:
#    - Corner targets sit strictly OUTSIDE the 65x65mm work zone.
#    - The exact corner vertex (X, Y) is the inner tangent vertex of the target.
#    - Zero ink enters the interior: 100% pure unprinted white paper.
#    - Crosshairs align with the perimeter dashed lines and extend outward.
# 2. Camera Pose & Leveling / Framing System:
#    - Outer Framing Corner Brackets (140 x 105 mm, 4:3 aspect ratio matching most webcams).
#      Provides an intuitive guide for camera height and optical centering.
#    - Horizontal & Vertical Orthogonal Horizon Guides (Roll & Pitch nulling indicators).
#    - Symmetry tick marks to visually detect camera trapezoid tilt.
# 3. Compound Vernier Perimeter Dashed Line:
#    - [3.0, 1.0, 1.0, 1.0 mm] dual-frequency Vernier extinction pattern.
#    - Sagitta Midpoint Ticks (outward only) for maximum lens bow indicator.
# 4. Balanced Dual-Axis (X & Y) 50mm Metrology L-Ruler Gauge.

PAGE_W = 279.4  # US Letter width in mm
PAGE_H = 215.9  # US Letter height in mm
CX = PAGE_W / 2.0  # 139.7 mm
CY = PAGE_H / 2.0  # 107.95 mm

WORK_SIZE = 65.0  # 65 x 65 mm square
HALF_W = WORK_SIZE / 2.0

X1 = CX - HALF_W  # 107.2 mm
Y1 = CY - HALF_W - 5.0  # 70.45 mm
X2 = CX + HALF_W  # 172.2 mm
Y2 = Y1 + WORK_SIZE  # 135.45 mm

# Target Dimensions (strictly outward from vertex)
QT_SIZE = 7.0
CROSS_EXT = 8.0

def make_outward_target(vx, vy, corner_idx):
    """
    Creates an ultra-clean, minimalist outward L-crosshair meeting EXACTLY at (vx, vy).
    
    Geometry:
      - Two solid orthogonal arms (stroke 0.60mm, length 8.0mm) extend strictly OUTWARD
        along the perimeter axes (X and Y directions).
      - Zero diagonal clutter, zero outer boxes, zero confusing outer dots.
      - A crisp red micro-reticle dot (0.35mm radius) marks the exact intersection node (vx, vy).
      - ZERO ink penetrates the interior 90-degree quadrant [X1..X2, Y1..Y2].
      - Corner label (C0, C1, C2, C3) positioned neatly in the outer quadrant.
    """
    elem = []
    # Signs for outward direction:
    sx = -1.0 if corner_idx in (0, 3) else 1.0
    sy = -1.0 if corner_idx in (0, 1) else 1.0
    
    ARM_LEN = 8.0
    
    # 1. Orthogonal Outward Arms (solid 0.60mm, extending directly from vertex along perimeter axes)
    # Horizontal outward arm along Y=vy
    elem.append(f'<line x1="{vx:.2f}" y1="{vy:.2f}" x2="{vx + sx * ARM_LEN:.2f}" y2="{vy:.2f}" stroke="#000000" stroke-width="0.60" stroke-linecap="square" />')
    # Vertical outward arm along X=vx
    elem.append(f'<line x1="{vx:.2f}" y1="{vy:.2f}" x2="{vx:.2f}" y2="{vy + sy * ARM_LEN:.2f}" stroke="#000000" stroke-width="0.60" stroke-linecap="square" />')
    
    # 2. Center Pin Alignment Node: High-precision red micro-dot directly at (vx, vy)
    elem.append(f'<circle cx="{vx:.2f}" cy="{vy:.2f}" r="0.35" fill="#dc2626" />')
    
    # 3. Corner Identifier Label (TL=C0, TR=C1, BR=C2, BL=C3)
    lbl_x = vx + sx * 10.0
    lbl_y = vy + sy * 10.0
    labels = ["C0", "C1", "C2", "C3"]
    elem.append(f'<text x="{lbl_x:.2f}" y="{lbl_y:.2f}" class="lbl">{labels[corner_idx]}</text>')
    
    return '\n  '.join(elem)

svg = []
svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {PAGE_W:.2f} {PAGE_H:.2f}" width="{PAGE_W:.2f}mm" height="{PAGE_H:.2f}mm">')
svg.append('''  <defs>
    <style>
      .dashed-edge { stroke: #000000; stroke-width: 0.45; stroke-dasharray: 3.0, 1.0, 1.0, 1.0; fill: none; }
      .sagitta-tick { stroke: #000000; stroke-width: 0.50; fill: none; }
      .frame-guide { stroke: #64748b; stroke-width: 0.35; fill: none; stroke-dasharray: 4.0, 2.0; }
      .frame-bracket { stroke: #0f172a; stroke-width: 0.60; fill: none; }
      .horizon-line { stroke: #94a3b8; stroke-width: 0.25; stroke-dasharray: 2.0, 2.0; fill: none; }
      .lbl { font-family: "DejaVu Sans", "Helvetica Neue", Arial, monospace; font-size: 3.2px; fill: #1e293b; font-weight: bold; text-anchor: middle; dominant-baseline: middle; }
      .guide-txt { font-family: "DejaVu Sans", "Helvetica Neue", Arial, monospace; font-size: 1.6px; fill: #64748b; text-anchor: middle; }
      .ruler-txt { font-family: "DejaVu Sans", "Helvetica Neue", Arial, monospace; font-size: 1.8px; fill: #475569; text-anchor: middle; letter-spacing: 0.4px; }
      .ruler-num { font-family: "DejaVu Sans", "Helvetica Neue", Arial, monospace; font-size: 1.5px; fill: #1e293b; text-anchor: middle; font-weight: 600; }
    </style>
  </defs>''')

# 100% Clean White Page
svg.append(f'  <rect x="0" y="0" width="{PAGE_W:.2f}" height="{PAGE_H:.2f}" fill="#ffffff" />')

# =========================================================================
# 1. CLOSE-UP CAMERA POSE & FRAMING GUIDES (Within Tight FOV)
# =========================================================================
# Since the camera is close to the piece, only elements within 5-10mm of the
# 65x65mm work area are visible in the video frame.
#
# A. Tight Framing Crop Brackets: 77.0 x 77.0 mm (6.0mm outside corners)
#    These brackets give the exact boundary of the minimum recommended camera FOV.
#    When camera height is optimal, these 4 brackets sit just inside video edges.
TIGHT_OFFSET = 6.0
C_LEN = 3.5
# TL Bracket
svg.append(f'  <!-- Tight In-FOV Camera Framing Brackets (77x77mm) -->')
svg.append(f'  <path d="M {X1-TIGHT_OFFSET:.2f} {Y1-TIGHT_OFFSET+C_LEN:.2f} L {X1-TIGHT_OFFSET:.2f} {Y1-TIGHT_OFFSET:.2f} L {X1-TIGHT_OFFSET+C_LEN:.2f} {Y1-TIGHT_OFFSET:.2f}" class="frame-bracket" />')
# TR Bracket
svg.append(f'  <path d="M {X2+TIGHT_OFFSET-C_LEN:.2f} {Y1-TIGHT_OFFSET:.2f} L {X2+TIGHT_OFFSET:.2f} {Y1-TIGHT_OFFSET:.2f} L {X2+TIGHT_OFFSET:.2f} {Y1-TIGHT_OFFSET+C_LEN:.2f}" class="frame-bracket" />')
# BR Bracket
svg.append(f'  <path d="M {X2+TIGHT_OFFSET:.2f} {Y2+TIGHT_OFFSET-C_LEN:.2f} L {X2+TIGHT_OFFSET:.2f} {Y2+TIGHT_OFFSET:.2f} L {X2+TIGHT_OFFSET-C_LEN:.2f} {Y2+TIGHT_OFFSET:.2f}" class="frame-bracket" />')
# BL Bracket
svg.append(f'  <path d="M {X1-TIGHT_OFFSET+C_LEN:.2f} {Y2+TIGHT_OFFSET:.2f} L {X1-TIGHT_OFFSET:.2f} {Y2+TIGHT_OFFSET:.2f} L {X1-TIGHT_OFFSET:.2f} {Y2+TIGHT_OFFSET-C_LEN:.2f}" class="frame-bracket" />')

# B. Close-In Horizon / Roll Leveling Guides (4.5mm outside top & bottom edges)
#    Thin dashed parallel lines just outside the work area to visually verify roll alignment against screen bezels.
svg.append(f'  <!-- In-FOV Horizon Leveling Dashes -->')
svg.append(f'  <line x1="{X1-4.0:.2f}" y1="{Y1-4.5:.2f}" x2="{X2+4.0:.2f}" y2="{Y1-4.5:.2f}" class="horizon-line" />')
svg.append(f'  <line x1="{X1-4.0:.2f}" y1="{Y2+4.5:.2f}" x2="{X2+4.0:.2f}" y2="{Y2+4.5:.2f}" class="horizon-line" />')

# North / Top Orientation Indicator (compact, right above top edge)
svg.append(f'  <!-- Orientation Indicator (TOP / NORTH) -->')
svg.append(f'  <path d="M {CX} {Y1-3.2:.2f} L {CX-1.8:.2f} {Y1-1.2:.2f} L {CX+1.8:.2f} {Y1-1.2:.2f} Z" fill="#000000" />')

# =========================================================================
# 2. 65x65mm WORK AREA & PERIMETER DASHED LINE
# =========================================================================
# The interior [X1..X2, Y1..Y2] is 100% clean white paper. Zero ink inside!
svg.append(f'  <!-- 65x65mm Perimeter Dashed Line (Optical Nulling Baseline) -->')
svg.append(f'  <rect x="{X1:.2f}" y="{Y1:.2f}" width="{WORK_SIZE:.2f}" height="{WORK_SIZE:.2f}" class="dashed-edge" />')

# Midpoint Sagitta Ticks ONLY (2.5mm outward at exact 50% max bow point):
MID_X = CX
MID_Y = Y1 + HALF_W
TICK_LEN = 2.5
svg.append(f'  <!-- Sagitta Midpoint Ticks (Maximum Lens Bow Indicators) -->')
svg.append(f'  <line x1="{MID_X:.2f}" y1="{Y1:.2f}" x2="{MID_X:.2f}" y2="{Y1-TICK_LEN:.2f}" class="sagitta-tick" />')
svg.append(f'  <line x1="{MID_X:.2f}" y1="{Y2:.2f}" x2="{MID_X:.2f}" y2="{Y2+TICK_LEN:.2f}" class="sagitta-tick" />')
svg.append(f'  <line x1="{X1:.2f}" y1="{MID_Y:.2f}" x2="{X1-TICK_LEN:.2f}" y2="{MID_Y:.2f}" class="sagitta-tick" />')
svg.append(f'  <line x1="{X2:.2f}" y1="{MID_Y:.2f}" x2="{X2+TICK_LEN:.2f}" y2="{MID_Y:.2f}" class="sagitta-tick" />')

# =========================================================================
# 3. ZERO-BLEED OUTWARD-TANGENT CORNER TARGETS
# =========================================================================
# All 4 targets reside STRICTLY outside the work zone
svg.append(f'  <!-- Zero-Bleed Outward-Tangent Corner Targets -->')
svg.append('  ' + make_outward_target(X1, Y1, 0))
svg.append('  ' + make_outward_target(X2, Y1, 1))
svg.append('  ' + make_outward_target(X2, Y2, 2))
svg.append('  ' + make_outward_target(X1, Y2, 3))

# =========================================================================
# 4. DUAL-AXIS (X & Y) 50mm METROLOGY L-RULER
# =========================================================================
L_X = CX - 25.0
L_Y = Y2 + 15.0
BAR_W = 3.5

svg.append(f'  <!-- Dual-Axis (X & Y) 50mm Metrology Ruler -->')
# X-Axis Arm
for b in range(5):
    bx = L_X + b * 10.0
    fill = "#000000" if b % 2 == 0 else "#ffffff"
    svg.append(f'  <rect x="{bx:.2f}" y="{L_Y:.2f}" width="10.00" height="{BAR_W:.2f}" fill="{fill}" stroke="#000000" stroke-width="0.25" />')

# X-Axis Ticks
for mm in range(51):
    mx = L_X + mm * 1.0
    if mm % 10 == 0:
        tlen = 2.4
        sw = 0.28
        svg.append(f'  <text x="{mx:.2f}" y="{L_Y-3.0:.2f}" class="ruler-num">{mm}</text>')
    elif mm % 5 == 0:
        tlen = 1.5
        sw = 0.20
    else:
        tlen = 0.9
        sw = 0.14
    svg.append(f'  <line x1="{mx:.2f}" y1="{L_Y:.2f}" x2="{mx:.2f}" y2="{L_Y-tlen:.2f}" stroke="#000000" stroke-width="{sw:.2f}" />')

# Y-Axis Arm
for b in range(5):
    by = L_Y + b * 10.0
    fill = "#000000" if b % 2 == 0 else "#ffffff"
    svg.append(f'  <rect x="{L_X-BAR_W:.2f}" y="{by:.2f}" width="{BAR_W:.2f}" height="10.00" fill="{fill}" stroke="#000000" stroke-width="0.25" />')

# Y-Axis Ticks
for mm in range(51):
    my = L_Y + mm * 1.0
    if mm % 10 == 0:
        tlen = 2.4
        sw = 0.28
        svg.append(f'  <text x="{L_X-BAR_W-tlen-2.5:.2f}" y="{my+0.5:.2f}" class="ruler-num">{mm}</text>')
    elif mm % 5 == 0:
        tlen = 1.5
        sw = 0.20
    else:
        tlen = 0.9
        sw = 0.14
    svg.append(f'  <line x1="{L_X-BAR_W:.2f}" y1="{my:.2f}" x2="{L_X-BAR_W-tlen:.2f}" y2="{my:.2f}" stroke="#000000" stroke-width="{sw:.2f}" />')

# Labels
svg.append(f'  <text x="{L_X+25.0:.2f}" y="{L_Y+BAR_W+4.2:.2f}" class="ruler-txt">50 mm (X-AXIS)</text>')
svg.append(f'  <text x="{L_X+7.5:.2f}" y="{L_Y+25.0:.2f}" class="ruler-txt" transform="rotate(-90 {L_X+7.5:.2f} {L_Y+25.0:.2f})">50 mm (Y-AXIS)</text>')

import os
import subprocess

svg.append('</svg>')

out_dir = os.path.join(os.path.dirname(__file__), 'web-app', 'public')
os.makedirs(out_dir, exist_ok=True)

svg_path = os.path.join(out_dir, 'calibration_mat.svg')
pdf_path = os.path.join(out_dir, 'calibration_mat.pdf')
png_path = os.path.join(out_dir, 'calibration_mat.png')

with open(svg_path, 'w') as f:
    f.write('\n'.join(svg))

try:
    subprocess.run(['inkscape', svg_path, f'--export-filename={pdf_path}'], check=True)
    subprocess.run(['inkscape', svg_path, f'--export-filename={png_path}', '--export-dpi=300'], check=True)
    print(f"Mat v5.0 successfully generated and exported directly to {out_dir}!")
except Exception as e:
    print(f"SVG written to {svg_path}, but Inkscape export encountered: {e}")
