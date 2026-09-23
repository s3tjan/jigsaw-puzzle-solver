// JigSolve Physical Piece CV & Master Placement Studio JavaScript

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements - Header
  const presetSelect = document.getElementById('presetSelect');
  const customFileInput = document.getElementById('customFileInput');
  const uploadCustomBtn = document.getElementById('uploadCustomBtn');
  const rowsInput = document.getElementById('rowsInput');
  const colsInput = document.getElementById('colsInput');
  const applyGridBtn = document.getElementById('applyGridBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const gridInfoBadge = document.getElementById('gridInfoBadge');

  // DOM Elements - Camera & CV
  const webcamVideo = document.getElementById('webcamVideo');
  const startCamBtn = document.getElementById('startCamBtn');
  const capturePieceBtn = document.getElementById('capturePieceBtn');
  const autoThreshCheck = document.getElementById('autoThreshCheck');
  const invertBgCheck = document.getElementById('invertBgCheck');
  const manualThreshGroup = document.getElementById('manualThreshGroup');
  const threshSlider = document.getElementById('threshSlider');
  const threshVal = document.getElementById('threshVal');
  const autoThreshTag = document.getElementById('autoThreshTag');
  const cvCanvas = document.getElementById('cvCanvas');
  const cvEmptyOverlay = document.getElementById('cvEmptyOverlay');
  const layerButtons = document.querySelectorAll('.layer-btn');
  const expWarningBadge = document.getElementById('expWarningBadge');
  const lumHistCanvas = document.getElementById('lumHistCanvas');
  const otsuMarkerLabel = document.getElementById('otsuMarkerLabel');
  const colorHistCanvas = document.getElementById('colorHistCanvas');
  const hogCanvas = document.getElementById('hogCanvas');
  const meanLabText = document.getElementById('meanLabText');

  // DOM Elements - Telemetry
  // DOM Elements - Telemetry & HITL Assist
  const scanTimestamp = document.getElementById('scanTimestamp');
  const hitlBadge = document.getElementById('hitlBadge');
  const hitlEdge0 = document.getElementById('hitlEdge0');
  const hitlEdge1 = document.getElementById('hitlEdge1');
  const hitlEdge2 = document.getElementById('hitlEdge2');
  const hitlEdge3 = document.getElementById('hitlEdge3');
  const recheckCandidatesBtn = document.getElementById('recheckCandidatesBtn');
  const downloadDebugJsonBtn = document.getElementById('downloadDebugJsonBtn');
  const edgeAnalysisSummary = document.getElementById('edgeAnalysisSummary');
  const edgeTelemetryList = document.getElementById('edgeTelemetryList');
  const valThresh = document.getElementById('valThresh');
  const valInvertMode = document.getElementById('valInvertMode');
  const valStraightFit = document.getElementById('valStraightFit');
  const valPerimArea = document.getElementById('valPerimArea');
  const valCornerAvg = document.getElementById('valCornerAvg');
  const angleC0 = document.getElementById('angleC0');
  const angleC1 = document.getElementById('angleC1');
  const angleC2 = document.getElementById('angleC2');
  const angleC3 = document.getElementById('angleC3');

  // DOM Elements - Placement & Master
  const masterCanvas = document.getElementById('masterCanvas');
  const reticleStatus = document.getElementById('reticleStatus');
  const placementHero = document.getElementById('placementHero');
  const candidateCards = document.getElementById('candidateCards');

  // State
  let masterImageObj = null;
  let masterGrid = { rows: 25, cols: 40 };
  let mediaStream = null;
  let latestAnalysis = null;
  let selectedCandidateIndex = 0;
  let reticlePulsePhase = 0;
  let masterAnimationId = null;

  const activeLayers = {
    img: true,
    contour: true,
    corners: true,
    vectors: true,
    rawContour: false,
    zebra: true,
    mask: false,
  };

  // 1. Fetch & Initialize Master Artwork Information
  async function loadMasterInfo() {
    try {
      const res = await fetch('/api/master/info');
      const data = await res.json();
      masterGrid.rows = data.rows;
      masterGrid.cols = data.cols;
      rowsInput.value = data.rows;
      colsInput.value = data.cols;
      gridInfoBadge.textContent = `${data.rows * data.cols} Pieces (${data.rows}×${data.cols})`;

      if (data.image_base64) {
        const img = new Image();
        img.onload = () => {
          masterImageObj = img;
          renderMasterBoard();
        };
        img.src = `data:image/png;base64,${data.image_base64}`;
      }
    } catch (err) {
      console.error('Failed to load master info:', err);
    }
  }

  // 2. Camera Stream Ingestion
  async function startCamera() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 960 },
          facingMode: 'environment',
        },
      });
      webcamVideo.srcObject = mediaStream;
      startCamBtn.textContent = 'Stop Camera';
      startCamBtn.classList.add('active');
      statusDot.className = 'status-dot ready';
      statusText.textContent = 'Camera Active';
    } catch (err) {
      console.error('Camera access failed:', err);
      alert('Could not access camera: ' + err.message);
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
      webcamVideo.srcObject = null;
      startCamBtn.textContent = 'Start Camera';
      startCamBtn.classList.remove('active');
      statusText.textContent = 'System Ready';
    }
  }

  startCamBtn.addEventListener('click', () => {
    if (mediaStream) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  // 3. Settings controls
  autoThreshCheck.addEventListener('change', () => {
    const isAuto = autoThreshCheck.checked;
    manualThreshGroup.style.opacity = isAuto ? '0.4' : '1.0';
    manualThreshGroup.style.pointerEvents = isAuto ? 'none' : 'auto';
    autoThreshTag.textContent = isAuto ? 'Otsu Auto: ON' : 'Otsu Auto: OFF';
    threshVal.textContent = isAuto ? 'Auto' : threshSlider.value;
  });

  threshSlider.addEventListener('input', () => {
    threshVal.textContent = threshSlider.value;
  });

  // Layer buttons
  layerButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const layer = btn.dataset.layer;
      activeLayers[layer] = !activeLayers[layer];
      btn.classList.toggle('active', activeLayers[layer]);
      if (latestAnalysis) {
        renderCvCanvas(latestAnalysis);
      }
    });
  });

  // Preset Selection & File Upload
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value === 'custom') {
      uploadCustomBtn.style.display = 'inline-block';
      customFileInput.click();
    } else {
      uploadCustomBtn.style.display = 'none';
      updateMasterPreset('starry_night', null);
    }
  });

  uploadCustomBtn.addEventListener('click', () => customFileInput.click());

  customFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      updateMasterPreset('custom', reader.result);
    };
    reader.readAsDataURL(file);
  });

  applyGridBtn.addEventListener('click', () => {
    const r = parseInt(rowsInput.value, 10) || 25;
    const c = parseInt(colsInput.value, 10) || 40;
    updateMasterPreset(presetSelect.value, null, r, c);
  });

  async function updateMasterPreset(preset, imgData, r, c) {
    statusDot.className = 'status-dot busy';
    statusText.textContent = 'Updating Master Reference...';
    try {
      const payload = {
        preset: preset,
        rows: r || parseInt(rowsInput.value, 10) || 25,
        cols: c || parseInt(colsInput.value, 10) || 40,
        image_data: imgData || '',
      };
      const res = await fetch('/api/master/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      masterGrid.rows = data.rows;
      masterGrid.cols = data.cols;
      gridInfoBadge.textContent = `${data.rows * data.cols} Pieces (${data.rows}×${data.cols})`;

      if (data.image_base64) {
        const img = new Image();
        img.onload = () => {
          masterImageObj = img;
          renderMasterBoard();
          statusDot.className = 'status-dot ready';
          statusText.textContent = 'Master Updated';
        };
        img.src = `data:image/png;base64,${data.image_base64}`;
      }
    } catch (err) {
      console.error(err);
      statusDot.className = 'status-dot ready';
      statusText.textContent = 'Error updating master';
    }
  }

  // 4. Capture & Analyze Physical Piece
  capturePieceBtn.addEventListener('click', async () => {
    let capturedDataUrl = '';

    if (mediaStream && webcamVideo.videoWidth > 0) {
      // Capture from live camera
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = webcamVideo.videoWidth;
      snapCanvas.height = webcamVideo.videoHeight;
      const snapCtx = snapCanvas.getContext('2d');
      snapCtx.drawImage(webcamVideo, 0, 0);

      // Crop center square corresponding to reticle
      const size = Math.min(snapCanvas.width, snapCanvas.height) * 0.65;
      const sx = (snapCanvas.width - size) / 2;
      const sy = (snapCanvas.height - size) / 2;

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = 500;
      cropCanvas.height = 500;
      const cropCtx = cropCanvas.getContext('2d');
      cropCtx.drawImage(snapCanvas, sx, sy, size, size, 0, 0, 500, 500);

      capturedDataUrl = cropCanvas.toDataURL('image/png');
    } else {
      // If camera not running, prompt user to pick an image file or test with sample
      alert('Camera is not active. Please click "Start Camera" or select an image.');
      return;
    }

    await processImageScan(capturedDataUrl);
  });

  async function processImageScan(dataUrl) {
    statusDot.className = 'status-dot busy';
    statusText.textContent = 'Processing Computer Vision...';

    const reqPayload = {
      image_data: dataUrl,
      threshold: autoThreshCheck.checked ? 0 : parseInt(threshSlider.value, 10),
      invert_bg: invertBgCheck.checked,
    };

    try {
      const res = await fetch('/api/cv/process-piece', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqPayload),
      });

      const data = await res.json();
      if (!data.success) {
        alert('Computer Vision Segmentation Error: ' + data.error);
        statusDot.className = 'status-dot ready';
        statusText.textContent = 'Segmentation Failed';
        return;
      }

      latestAnalysis = data;
      selectedCandidateIndex = 0;

      // Update Telemetry Panel
      displayTelemetry(data);

      // Render Multi-layer CV Canvas
      renderCvCanvas(data);

      // Render Master Artwork with Placement Marker & Rotation Directive
      renderMasterBoard();
      renderPlacementHero(data, 0);
      renderCandidateCards(data.top_candidates);

      statusDot.className = 'status-dot ready';
      statusText.textContent = 'Piece Located!';
      cvEmptyOverlay.style.display = 'none';
    } catch (err) {
      console.error(err);
      statusDot.className = 'status-dot ready';
      statusText.textContent = 'Error processing scan';
    }
  }

  // 5. Render Multi-layer Computer Vision Canvas
  function renderCvCanvas(data) {
    const ctx = cvCanvas.getContext('2d');
    const cw = cvCanvas.width;
    const ch = cvCanvas.height;
    ctx.clearRect(0, 0, cw, ch);

    if (!data.piece_image) return;

    const img = new Image();
    img.onload = () => {
      // Calculate scale to center piece
      const scale = Math.min((cw * 0.8) / img.width, (ch * 0.8) / img.height);
      const ox = (cw - img.width * scale) / 2;
      const oy = (ch - img.height * scale) / 2;

      // Layer 1: Raw piece photo
      if (activeLayers.img) {
        ctx.save();
        ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale);
        ctx.restore();
      }

      // Layer 2: 160-point smoothed perimeter contour
      if (activeLayers.contour && data.contour && data.contour.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.5;
        ctx.beginPath();

        // Transform contour points from raw piece space to canvas
        // Piece bounding box is normalized in piece_image
        const minX = Math.min(...data.contour.map((p) => p.x));
        const minY = Math.min(...data.contour.map((p) => p.y));

        data.contour.forEach((p, i) => {
          const px = ox + (p.x - minX) * scale;
          const py = oy + (p.y - minY) * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();

        // Draw small points along perimeter
        ctx.fillStyle = '#67e8f9';
        data.contour.forEach((p, i) => {
          if (i % 8 === 0) {
            const px = ox + (p.x - minX) * scale;
            const py = oy + (p.y - minY) * scale;
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        });
        ctx.restore();
      }

      // Layer 3: Curvature and Normal Vectors
      if (activeLayers.vectors && data.edge_telemetry) {
        ctx.save();
        const minX = Math.min(...data.contour.map((p) => p.x));
        const minY = Math.min(...data.contour.map((p) => p.y));

        const edgeColors = ['#38bdf8', '#a855f7', '#f59e0b', '#10b981'];

        data.edge_telemetry.forEach((et, idx) => {
          if (!et.midpoint) return;
          const mx = ox + (et.midpoint.x - minX) * scale;
          const my = oy + (et.midpoint.y - minY) * scale;

          // Draw outward normal vector
          const nx = et.outward_normal.x * 20;
          const ny = et.outward_normal.y * 20;

          ctx.strokeStyle = edgeColors[idx];
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(mx + nx, my + ny);
          ctx.stroke();
          ctx.setLineDash([]);

          // Peak point circle
          if (et.peak_point) {
            const pkX = ox + (et.peak_point.x - minX) * scale;
            const pkY = oy + (et.peak_point.y - minY) * scale;
            ctx.fillStyle = edgeColors[idx];
            ctx.beginPath();
            ctx.arc(pkX, pkY, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        });
        ctx.restore();
      }

      // Layer 4: 4 Physical Corners
      if (activeLayers.corners && data.corner_points) {
        ctx.save();
        const minX = Math.min(...data.contour.map((p) => p.x));
        const minY = Math.min(...data.contour.map((p) => p.y));

        const labels = ['C0 (TL)', 'C1 (TR)', 'C2 (BR)', 'C3 (BL)'];

        data.corner_points.forEach((cp, i) => {
          const cx = ox + (cp.x - minX) * scale;
          const cy = oy + (cp.y - minY) * scale;

          // Glowing corner dot
          ctx.fillStyle = '#f43f5e';
          ctx.shadowColor = '#f43f5e';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;

          // Corner label
          ctx.font = '10px JetBrains Mono';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(labels[i], cx + 8, cy - 8);
        });
        ctx.restore();
      }

      // Layer 5: Raw Discretized Pixel Contour
      if (activeLayers.rawContour && data.raw_contour && data.raw_contour.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();

        const minX = Math.min(...data.contour.map((p) => p.x));
        const minY = Math.min(...data.contour.map((p) => p.y));

        data.raw_contour.forEach((p, i) => {
          const px = ox + (p.x - minX) * scale;
          const py = oy + (p.y - minY) * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Layer 6: Binary Threshold Mask
      if (activeLayers.mask && data.mask_image) {
        const maskImg = new Image();
        maskImg.onload = () => {
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.drawImage(maskImg, ox, oy, img.width * scale, img.height * scale);
          ctx.restore();
        };
        maskImg.src = `data:image/png;base64,${data.mask_image}`;
      }

      // Layer 7: Over-Exposure Zebra Glare Warning Overlay
      if (activeLayers.zebra && activeLayers.img) {
        ctx.save();
        // Sample rendered piece pixels to detect highlights (> 225 brightness)
        const pieceW = Math.round(img.width * scale);
        const pieceH = Math.round(img.height * scale);
        const startX = Math.round(ox);
        const startY = Math.round(oy);

        try {
          const imgData = ctx.getImageData(startX, startY, pieceW, pieceH);
          const pix = imgData.data;
          const zebraCanvas = document.createElement('canvas');
          zebraCanvas.width = pieceW;
          zebraCanvas.height = pieceH;
          const zCtx = zebraCanvas.getContext('2d');

          // Draw diagonal zebra stripes over glare pixels
          zCtx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
          zCtx.lineWidth = 2.5;

          let hasGlare = false;
          for (let y = 0; y < pieceH; y += 3) {
            for (let x = 0; x < pieceW; x += 3) {
              const idx = (y * pieceW + x) * 4;
              const a = pix[idx + 3];
              if (a > 30) {
                const lum = (pix[idx] * 299 + pix[idx + 1] * 587 + pix[idx + 2] * 114) / 1000;
                if (lum > 225) {
                  hasGlare = true;
                  // Draw short diagonal hash
                  zCtx.beginPath();
                  zCtx.moveTo(x - 3, y + 3);
                  zCtx.lineTo(x + 3, y - 3);
                  zCtx.stroke();
                }
              }
            }
          }

          if (hasGlare) {
            ctx.drawImage(zebraCanvas, startX, startY);
          }
        } catch (e) {
          // Security / tainted canvas fallback
        }
        ctx.restore();
      }
    };
    img.src = `data:image/png;base64,${data.piece_image}`;

    // Render Luminance Histogram & Exposure Status
    renderLuminanceHistogram(data);
  }

  // Render Exposure Histogram & Warnings
  function renderLuminanceHistogram(data) {
    if (!lumHistCanvas || !data.luminance_hist) return;
    const hCtx = lumHistCanvas.getContext('2d');
    const hw = lumHistCanvas.width;
    const hh = lumHistCanvas.height;
    hCtx.clearRect(0, 0, hw, hh);

    const hist = data.luminance_hist;
    let maxBin = 1;
    for (let i = 0; i < 256; i++) {
      if (hist[i] > maxBin) maxBin = hist[i];
    }

    // Draw dark background grid
    hCtx.fillStyle = '#060a12';
    hCtx.fillRect(0, 0, hw, hh);

    // Draw Histogram bars
    const barW = hw / 256;
    for (let i = 0; i < 256; i++) {
      const barH = (hist[i] / maxBin) * (hh - 4);
      if (i > 225) {
        hCtx.fillStyle = '#ef4444'; // Red warning for blown highlights
      } else if (i < (data.threshold_used || 90)) {
        hCtx.fillStyle = '#38bdf8'; // Blue for piece foreground (if light bg)
      } else {
        hCtx.fillStyle = '#64748b'; // Neutral gray for background
      }
      hCtx.fillRect(i * barW, hh - barH, Math.max(1, barW), barH);
    }

    // Draw vertical Otsu Threshold Marker
    if (data.threshold_used) {
      const tx = (data.threshold_used / 255) * hw;
      hCtx.strokeStyle = '#06b6d4';
      hCtx.lineWidth = 2;
      hCtx.setLineDash([2, 2]);
      hCtx.beginPath();
      hCtx.moveTo(tx, 0);
      hCtx.lineTo(tx, hh);
      hCtx.stroke();
      hCtx.setLineDash([]);
      if (otsuMarkerLabel) {
        otsuMarkerLabel.textContent = `Otsu Cut: ${data.threshold_used}`;
      }
    }

    // Update Exposure Warning Badge
    if (expWarningBadge) {
      const satCount = data.saturated_count || 0;
      if (satCount > 800) {
        expWarningBadge.textContent = `High Glare (${satCount}px) - Adjust Lighting`;
        expWarningBadge.className = 'exp-badge severe';
      } else if (satCount > 80) {
        expWarningBadge.textContent = `Specular Glare (${satCount}px)`;
        expWarningBadge.className = 'exp-badge warn';
      } else {
        expWarningBadge.textContent = `Exposure OK (${satCount} sat)`;
        expWarningBadge.className = 'exp-badge good';
      }
    }

    // Render Color and HOG histograms
    renderColorHistogram(data);
    renderHOGHistogram(data);
  }

  // Render 64-bin RGB Spectral Distribution
  function renderColorHistogram(data) {
    if (!colorHistCanvas || !data.color_hist) return;
    const cCtx = colorHistCanvas.getContext('2d');
    const cw = colorHistCanvas.width;
    const ch = colorHistCanvas.height;
    cCtx.clearRect(0, 0, cw, ch);

    // Dark canvas background
    cCtx.fillStyle = '#060a12';
    cCtx.fillRect(0, 0, cw, ch);

    const rBins = data.color_hist.r || [];
    const gBins = data.color_hist.g || [];
    const bBins = data.color_hist.b || [];

    let maxBin = 1;
    for (let i = 0; i < 64; i++) {
      if (rBins[i] > maxBin) maxBin = rBins[i];
      if (gBins[i] > maxBin) maxBin = gBins[i];
      if (bBins[i] > maxBin) maxBin = bBins[i];
    }

    const step = cw / 64;

    // Draw R, G, B lines
    const channels = [
      { bins: rBins, color: 'rgba(239, 68, 68, 0.85)' },
      { bins: gBins, color: 'rgba(34, 197, 94, 0.85)' },
      { bins: bBins, color: 'rgba(59, 130, 246, 0.85)' },
    ];

    channels.forEach((chan) => {
      cCtx.strokeStyle = chan.color;
      cCtx.lineWidth = 1.5;
      cCtx.beginPath();
      for (let i = 0; i < 64; i++) {
        const val = chan.bins[i] || 0;
        const x = i * step;
        const y = ch - (val / maxBin) * (ch - 4);
        if (i === 0) cCtx.moveTo(x, y);
        else cCtx.lineTo(x, y);
      }
      cCtx.stroke();
    });

    if (meanLabText && data.mean_lab) {
      meanLabText.textContent = `Lab[a:${data.mean_lab[1].toFixed(1)}, b:${data.mean_lab[2].toFixed(1)}]`;
    }
  }

  // Render 8-Bin Histogram of Oriented Gradients (HOG)
  function renderHOGHistogram(data) {
    if (!hogCanvas || !data.hog) return;
    const gCtx = hogCanvas.getContext('2d');
    const gw = hogCanvas.width;
    const gh = hogCanvas.height;
    gCtx.clearRect(0, 0, gw, gh);

    gCtx.fillStyle = '#060a12';
    gCtx.fillRect(0, 0, gw, gh);

    const hog = data.hog;
    let maxHog = 0.001;
    for (let i = 0; i < 8; i++) {
      if (hog[i] > maxHog) maxHog = hog[i];
    }

    const barW = (gw - 16) / 8;
    for (let i = 0; i < 8; i++) {
      const h = (hog[i] / maxHog) * (gh - 8);
      const x = 8 + i * barW;
      const y = gh - h - 2;

      // Color gradation across gradient angles
      const hue = (i * 45) % 360;
      gCtx.fillStyle = `hsl(${hue}, 70%, 60%)`;
      gCtx.fillRect(x + 1, y, barW - 2, h);
    }
  }

  // 6. Display Telemetry & Sync Human-in-the-Loop Assist
  function displayTelemetry(data) {
    scanTimestamp.textContent = new Date().toLocaleTimeString();

    // 1. Sync HITL Overrides
    if (data.edge_types && data.edge_types.length >= 4) {
      hitlEdge0.value = data.edge_types[0];
      hitlEdge1.value = data.edge_types[1];
      hitlEdge2.value = data.edge_types[2];
      hitlEdge3.value = data.edge_types[3];
      hitlBadge.textContent = 'Auto-Classified';
      hitlBadge.style.color = 'var(--accent-emerald)';
    }

    // 2. CV Pipeline Diagnostics
    valThresh.textContent = `${data.threshold_used}`;
    valInvertMode.textContent = data.invert_bg_used ? 'Inverted (Light Paper)' : 'Direct (Dark Board)';

    let minDevRatio = 1.0;
    if (data.edge_telemetry) {
      data.edge_telemetry.forEach((et) => {
        if (et.curvature_ratio < minDevRatio) {
          minDevRatio = et.curvature_ratio;
        }
      });
    }
    valStraightFit.textContent = `${((1.0 - Math.min(1.0, minDevRatio)) * 100).toFixed(1)}% Linear`;
    valPerimArea.textContent = `${data.perimeter.toFixed(0)}px / ${data.area.toFixed(0)}px²`;

    // 3. Corner Angles
    if (data.corner_angles) {
      angleC0.textContent = `${data.corner_angles[0].toFixed(1)}°`;
      angleC1.textContent = `${data.corner_angles[1].toFixed(1)}°`;
      angleC2.textContent = `${data.corner_angles[2].toFixed(1)}°`;
      angleC3.textContent = `${data.corner_angles[3].toFixed(1)}°`;
      const avgAngle =
        (data.corner_angles[0] + data.corner_angles[1] + data.corner_angles[2] + data.corner_angles[3]) / 4;
      valCornerAvg.textContent = `Avg: ${avgAngle.toFixed(1)}°`;
    }

    // 4. Edge-by-Edge Breakdown
    const dirs = ['Top Edge (C0→C1)', 'Right Edge (C1→C2)', 'Bottom Edge (C2→C3)', 'Left Edge (C3→C0)'];
    const dirClasses = ['top', 'right', 'bottom', 'left'];

    let edgesHtml = '';
    data.edge_types.forEach((et, i) => {
      const telem = data.edge_telemetry ? data.edge_telemetry[i] : null;
      const chord = telem ? telem.chord_length.toFixed(1) : '--';
      const maxProt = telem ? telem.max_protrusion.toFixed(1) : '0';
      const minInd = telem ? telem.min_indentation.toFixed(1) : '0';
      const ratio = telem ? (telem.curvature_ratio * 100).toFixed(1) : '--';

      edgesHtml += `
        <div class="edge-card-row ${dirClasses[i]}">
          <div class="edge-name">
            <span>${dirs[i]}</span>
            <span class="edge-type-chip ${et.toLowerCase()}">${et}</span>
          </div>
          <div class="edge-stats">
            <div>Chord: ${chord}px | Dev: ${ratio}%</div>
            <div>+Tab: ${maxProt}px | -Blank: ${minInd}px</div>
          </div>
        </div>
      `;
    });
    edgeTelemetryList.innerHTML = edgesHtml;
  }

  // Handle Human-in-the-Loop Re-ranking
  [hitlEdge0, hitlEdge1, hitlEdge2, hitlEdge3].forEach((sel) => {
    sel.addEventListener('change', () => {
      hitlBadge.textContent = 'Human Override Active';
      hitlBadge.style.color = 'var(--accent-amber)';
    });
  });

  recheckCandidatesBtn.addEventListener('click', async () => {
    if (!latestAnalysis || !latestAnalysis.descriptor) {
      alert('Scan a piece first before overriding topology.');
      return;
    }

    const overriddenEdges = [hitlEdge0.value, hitlEdge1.value, hitlEdge2.value, hitlEdge3.value];
    statusDot.className = 'status-dot busy';
    statusText.textContent = 'Re-ranking with user overrides...';

    try {
      const res = await fetch('/api/cv/rerank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          descriptor: latestAnalysis.descriptor,
          edge_types: overriddenEdges,
        }),
      });
      const data = await res.json();
      if (data.success) {
        latestAnalysis.top_candidates = data.top_candidates;
        latestAnalysis.edge_types = overriddenEdges;
        selectedCandidateIndex = 0;
        renderPlacementHero(latestAnalysis, 0);
        renderCandidateCards(data.top_candidates);
        renderMasterBoard();
        statusDot.className = 'status-dot ready';
        statusText.textContent = 'Placement Updated!';
      }
    } catch (err) {
      console.error(err);
      statusDot.className = 'status-dot ready';
      statusText.textContent = 'Re-rank failed';
    }
  });

  // Download Debug JSON
  downloadDebugJsonBtn.addEventListener('click', () => {
    if (!latestAnalysis) {
      alert('No scan data to export yet.');
      return;
    }
    const blob = new Blob([JSON.stringify(latestAnalysis, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `puzzle_piece_debug_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // 7. Master Artwork Canvas Rendering
  function renderMasterBoard() {
    const ctx = masterCanvas.getContext('2d');
    const cw = masterCanvas.width;
    const ch = masterCanvas.height;
    ctx.clearRect(0, 0, cw, ch);

    if (!masterImageObj) return;

    // Draw painting
    ctx.drawImage(masterImageObj, 0, 0, cw, ch);

    // Draw Subtle Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 0.5;

    const cellW = cw / masterGrid.cols;
    const cellH = ch / masterGrid.rows;

    for (let r = 0; r <= masterGrid.rows; r += 5) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellH);
      ctx.lineTo(cw, r * cellH);
      ctx.stroke();
    }
    for (let c = 0; c <= masterGrid.cols; c += 5) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, 0);
      ctx.lineTo(c * cellW, ch);
      ctx.stroke();
    }

    // If we have an active candidate match, highlight the slot with an animated reticle
    if (latestAnalysis && latestAnalysis.top_candidates && latestAnalysis.top_candidates.length > 0) {
      const cand = latestAnalysis.top_candidates[selectedCandidateIndex];
      const slotX = cand.col * cellW;
      const slotY = cand.row * cellH;

      reticlePulsePhase += 0.05;
      const pulse = Math.sin(reticlePulsePhase) * 3;

      // Glow Box
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 12 + pulse;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.fillRect(slotX, slotY, cellW, cellH);
      ctx.strokeRect(slotX - 1, slotY - 1, cellW + 2, cellH + 2);

      // Crosshair lines
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, slotY + cellH / 2);
      ctx.lineTo(cw, slotY + cellH / 2);
      ctx.moveTo(slotX + cellW / 2, 0);
      ctx.lineTo(slotX + cellW / 2, ch);
      ctx.stroke();
      ctx.restore();

      reticleStatus.textContent = `Row ${cand.row + 1}, Col ${cand.col + 1} (${((1.0 - cand.distance) * 100).toFixed(0)}% Match)`;
    }
  }

  // Animation Loop for Master Reticle
  function animLoop() {
    if (latestAnalysis && latestAnalysis.top_candidates && latestAnalysis.top_candidates.length > 0) {
      renderMasterBoard();
    }
    masterAnimationId = requestAnimationFrame(animLoop);
  }
  masterAnimationId = requestAnimationFrame(animLoop);

  // 8. Placement & Rotation Directive Card with Match Explanation Breakdown
  function renderPlacementHero(data, candidateIdx) {
    if (!data.top_candidates || data.top_candidates.length === 0) {
      placementHero.innerHTML = '<div class="hero-empty">No matching candidates found</div>';
      return;
    }

    const cand = data.top_candidates[candidateIdx];
    const matchPct = Math.max(0, Math.min(100, (1.0 - cand.distance) * 100));
    const rot = cand.rotation || 0;

    let rotDirective = '';
    let rotBadgeText = '0°';
    if (rot === 0) {
      rotDirective = 'Maintain Current Orientation (0°)';
      rotBadgeText = '0°';
    } else if (rot === 90) {
      rotDirective = 'Rotate 90° Clockwise';
      rotBadgeText = 'CW 90°';
    } else if (rot === 180) {
      rotDirective = 'Rotate 180° (Half-Turn)';
      rotBadgeText = '180°';
    } else if (rot === 270) {
      rotDirective = 'Rotate 270° CW (90° Counter-Clockwise)';
      rotBadgeText = 'CW 270°';
    }

    // Extract match breakdown metrics
    const metrics = cand.metrics || {};
    const hueSim = metrics.hue_similarity != null ? metrics.hue_similarity : matchPct;
    const chromaSim = metrics.chroma_similarity != null ? metrics.chroma_similarity : matchPct;
    const gradSim = metrics.gradient_similarity != null ? metrics.gradient_similarity : 50.0;

    placementHero.innerHTML = `
      <div class="hero-content">
        <div class="hero-header">
          <div class="hero-title">Location: Row ${cand.row + 1}, Column ${cand.col + 1}</div>
          <span class="hero-match-badge">${matchPct.toFixed(1)}% Match</span>
        </div>

        <div class="hero-split">
          <div class="hero-crop-comparison">
            <div class="crop-preview-box" title="Your Scanned Physical Piece">
              <img src="data:image/png;base64,${data.piece_image}" alt="Scan">
            </div>
            <span class="crop-divider-label">VS</span>
            <div class="crop-preview-box" title="Corresponding Artwork Slot">
              <img src="data:image/png;base64,${cand.candidate_image || ''}" alt="Artwork">
            </div>
          </div>

          <div class="rotation-directive-box">
            <div class="rot-degree-badge">${rotBadgeText}</div>
            <div class="rot-text-wrap">
              <span class="rot-heading">Required Orientation</span>
              <span class="rot-instruction">${rotDirective}</span>
            </div>
          </div>
        </div>

        <!-- Visual Match Metric Breakdown Charts -->
        <div class="match-explanation-panel">
          <div class="match-exp-title">Why This Piece Matches Here:</div>
          
          <div class="match-metric-row">
            <div class="metric-row-header">
              <span class="metric-row-label">Hue Angle Distribution Match:</span>
              <span class="metric-row-val">${hueSim.toFixed(1)}%</span>
            </div>
            <div class="metric-track">
              <div class="metric-fill hue" style="width: ${Math.max(4, Math.min(100, hueSim))}%;"></div>
            </div>
          </div>

          <div class="match-metric-row">
            <div class="metric-row-header">
              <span class="metric-row-label">CIE-Lab Chroma Distance Match:</span>
              <span class="metric-row-val">${chromaSim.toFixed(1)}%</span>
            </div>
            <div class="metric-track">
              <div class="metric-fill chroma" style="width: ${Math.max(4, Math.min(100, chromaSim))}%;"></div>
            </div>
          </div>

          <div class="match-metric-row">
            <div class="metric-row-header">
              <span class="metric-row-label">Texture & Gradient Alignment (HOG):</span>
              <span class="metric-row-val">${gradSim.toFixed(1)}%</span>
            </div>
            <div class="metric-track">
              <div class="metric-fill gradient" style="width: ${Math.max(4, Math.min(100, gradSim))}%;"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // 9. Top-3 Candidate Comparison Cards with Explanation Meters
  function renderCandidateCards(candidates) {
    if (!candidates || candidates.length === 0) {
      candidateCards.innerHTML = '<div class="candidate-empty">No candidates</div>';
      return;
    }

    let cardsHtml = '';
    candidates.forEach((cand, idx) => {
      const matchPct = Math.max(0, Math.min(100, (1.0 - cand.distance) * 100));
      const isSelected = idx === selectedCandidateIndex ? 'selected' : '';
      const rot = cand.rotation || 0;
      const m = cand.metrics || {};
      const hue = m.hue_similarity != null ? m.hue_similarity : matchPct;
      const chroma = m.chroma_similarity != null ? m.chroma_similarity : matchPct;
      const grad = m.gradient_similarity != null ? m.gradient_similarity : 50;

      cardsHtml += `
        <div class="candidate-card-item ${isSelected}" data-index="${idx}">
          <div class="candidate-card-summary">
            <div class="cand-left">
              <div class="cand-crop">
                <img src="data:image/png;base64,${cand.candidate_image || ''}" alt="Slot">
              </div>
              <div class="cand-coords">
                <span class="cand-rank">#${idx + 1} Candidate</span>
                <span class="cand-slot">Row ${cand.row + 1}, Col ${cand.col + 1}</span>
              </div>
            </div>
            <div class="cand-right">
              <span class="cand-confidence">${matchPct.toFixed(1)}% Match</span>
              <span class="cand-rot-chip">Rot: ${rot}° CW</span>
            </div>
          </div>

          <!-- Mini Match Metric Indicators -->
          <div class="candidate-metric-mini-bars">
            <div class="cand-mini-bar">
              <span class="cand-mini-label">Hue: ${hue.toFixed(0)}%</span>
              <div class="cand-mini-track">
                <div class="metric-fill hue" style="width: ${Math.max(5, Math.min(100, hue))}%;"></div>
              </div>
            </div>
            <div class="cand-mini-bar">
              <span class="cand-mini-label">Chroma: ${chroma.toFixed(0)}%</span>
              <div class="cand-mini-track">
                <div class="metric-fill chroma" style="width: ${Math.max(5, Math.min(100, chroma))}%;"></div>
              </div>
            </div>
            <div class="cand-mini-bar">
              <span class="cand-mini-label">Grad: ${grad.toFixed(0)}%</span>
              <div class="cand-mini-track">
                <div class="metric-fill gradient" style="width: ${Math.max(5, Math.min(100, grad))}%;"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    });

    candidateCards.innerHTML = cardsHtml;

    // Attach click listeners to candidates
    candidateCards.querySelectorAll('.candidate-card-item').forEach((item) => {
      item.addEventListener('click', () => {
        selectedCandidateIndex = parseInt(item.dataset.index, 10);
        renderCandidateCards(candidates);
        renderPlacementHero(latestAnalysis, selectedCandidateIndex);
        renderMasterBoard();
      });
    });
  }

  // Initial load
  loadMasterInfo();
});
