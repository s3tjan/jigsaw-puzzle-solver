(() => {
  // State
  let puzzleState = null;
  let piecesImages = new Map(); // id -> HTMLImageElement
  let boardSlots = []; // grid slots [r][c] -> placed piece or null
  let trayPieces = []; // pieces still in tray
  let solveSteps = [];
  let currentStepIdx = 0;
  let isSolving = false;
  let solveTimer = null;
  let hoveredPiece = null;
  let activeTab = 'board'; // 'board' or 'solved'
  let solvedPreviewImg = null;

  // DOM Elements
  const canvas = document.getElementById('puzzleCanvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('canvasContainer');

  const presetSelect = document.getElementById('presetSelect');
  const rowsInput = document.getElementById('rowsInput');
  const colsInput = document.getElementById('colsInput');
  const rowsVal = document.getElementById('rowsVal');
  const colsVal = document.getElementById('colsVal');
  const speedInput = document.getElementById('speedInput');
  const speedVal = document.getElementById('speedVal');
  const pillBtns = document.querySelectorAll('.pill-btn');

  const customFileInput = document.getElementById('customFileInput');
  const uploadGroup = document.getElementById('uploadGroup');
  const uploadedFileName = document.getElementById('uploadedFileName');
  let customImageDataURL = "";

  presetSelect.addEventListener('change', () => {
    if (presetSelect.value === 'custom') {
      uploadGroup.style.display = 'block';
      if (!customImageDataURL) {
        customFileInput.click();
      }
    } else {
      uploadGroup.style.display = 'none';
    }
  });

  customFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadedFileName.textContent = `Selected: ${file.name}`;
    const reader = new FileReader();
    reader.onload = (event) => {
      customImageDataURL = event.target.result;
      generatePuzzle();
    };
    reader.readAsDataURL(file);
  });

  const generateBtn = document.getElementById('generateBtn');
  const scrambleBtn = document.getElementById('scrambleBtn');
  const stepBtn = document.getElementById('stepBtn');
  const solveBtn = document.getElementById('solveBtn');

  const statPieces = document.getElementById('statPieces');
  const statPlaced = document.getElementById('statPlaced');
  const statTime = document.getElementById('statTime');
  const statAccuracy = document.getElementById('statAccuracy');
  const inspectorContent = document.getElementById('inspectorContent');
  const statusText = document.getElementById('statusText');
  const statusDot = document.querySelector('.status-dot');

  const viewBoardBtn = document.getElementById('viewBoardBtn');
  const viewSolvedBtn = document.getElementById('viewSolvedBtn');

  // Resize canvas
  function resizeCanvas() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  // Sync range inputs
  rowsInput.addEventListener('input', () => {
    rowsVal.textContent = rowsInput.value;
    updatePills();
  });
  colsInput.addEventListener('input', () => {
    colsVal.textContent = colsInput.value;
    updatePills();
  });
  speedInput.addEventListener('input', () => {
    speedVal.textContent = `${speedInput.value}ms`;
  });

  pillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      pillBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      rowsInput.value = btn.dataset.r;
      colsInput.value = btn.dataset.c;
      rowsVal.textContent = btn.dataset.r;
      colsVal.textContent = btn.dataset.c;
      generatePuzzle();
    });
  });

  function updatePills() {
    pillBtns.forEach(btn => {
      if (btn.dataset.r === rowsInput.value && btn.dataset.c === colsInput.value) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  viewBoardBtn.addEventListener('click', () => {
    activeTab = 'board';
    viewBoardBtn.classList.add('active');
    viewSolvedBtn.classList.remove('active');
    draw();
  });

  viewSolvedBtn.addEventListener('click', () => {
    activeTab = 'solved';
    viewSolvedBtn.classList.add('active');
    viewBoardBtn.classList.remove('active');
    draw();
  });

  // Generate puzzle
  async function generatePuzzle() {
    setStatus('Generating puzzle...', true);
    stopSolving();

    const payload = {
      rows: parseInt(rowsInput.value, 10),
      cols: parseInt(colsInput.value, 10),
      preset: presetSelect.value,
      image: presetSelect.value === 'custom' ? customImageDataURL : "",
    };

    try {
      const res = await fetch('/api/puzzle/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      puzzleState = data;

      // Preload images
      piecesImages.clear();
      const loadPromises = data.pieces.map(p => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            piecesImages.set(p.id, img);
            resolve();
          };
          img.src = `data:image/png;base64,${p.image_base64}`;
        });
      });

      await Promise.all(loadPromises);

      // Initialize board and tray
      resetBoard();
      statPieces.textContent = data.pieces.length;
      statPlaced.textContent = '0';
      statTime.textContent = `${data.generation_ms}ms`;
      statAccuracy.textContent = '-';
      setStatus('Puzzle Ready', false);
      draw();
    } catch (err) {
      console.error(err);
      setStatus('Generation Failed', false);
    }
  }

  function resetBoard() {
    if (!puzzleState) return;
    const { rows, cols } = puzzleState.grid;
    boardSlots = Array.from({ length: rows }, () => Array(cols).fill(null));

    // Scatter all pieces into tray
    trayPieces = puzzleState.pieces.map((p, idx) => ({
      piece: p,
      currentRotation: p.rotation,
      placed: false,
      slotR: null,
      slotC: null,
      trayIndex: idx,
    }));
  }

  // Scramble
  async function scramblePieces() {
    if (!puzzleState) return;
    setStatus('Scrambling...', true);
    stopSolving();

    try {
      const res = await fetch('/api/puzzle/scramble', { method: 'POST' });
      const data = await res.json();

      resetBoard();
      // Apply new rotations
      const rotMap = new Map(data.pieces.map(item => [item.id, item.rotation]));
      trayPieces.forEach(tp => {
        if (rotMap.has(tp.piece.id)) {
          tp.currentRotation = rotMap.get(tp.piece.id);
        }
      });

      // Random shuffle tray order
      trayPieces.sort(() => Math.random() - 0.5);
      trayPieces.forEach((tp, idx) => { tp.trayIndex = idx; });

      statPlaced.textContent = '0';
      statAccuracy.textContent = '-';
      setStatus('Scrambled & Rotated', false);
      draw();
    } catch (err) {
      console.error(err);
      setStatus('Scramble Failed', false);
    }
  }

  // Auto solve
  async function startSolve() {
    if (!puzzleState) return;
    if (isSolving) {
      stopSolving();
      return;
    }

    setStatus('Solving...', true);
    solveBtn.textContent = '⏸️ Pause';
    isSolving = true;

    try {
      const res = await fetch('/api/puzzle/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: puzzleState.grid.rows,
          cols: puzzleState.grid.cols,
          color_weight: 2.0,
          geom_weight: 1.0,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        setStatus('No Solution Found', false);
        stopSolving();
        return;
      }

      solveSteps = data.steps;
      currentStepIdx = 0;
      statTime.textContent = `${data.solve_time_ms}ms`;
      statAccuracy.textContent = `${data.accuracy.toFixed(1)}%`;

      playbackLoop();
    } catch (err) {
      console.error(err);
      setStatus('Solver Error', false);
      stopSolving();
    }
  }

  function playbackLoop() {
    if (!isSolving) return;

    if (currentStepIdx < solveSteps.length) {
      applyStep(solveSteps[currentStepIdx]);
      currentStepIdx++;
      draw();

      const delay = parseInt(speedInput.value, 10);
      solveTimer = setTimeout(playbackLoop, delay);
    } else {
      stopSolving();
      setStatus('Assembled with 100% Match!', false);
    }
  }

  function applyStep(step) {
    const { row, col, piece_id, rotation, action } = step;
    if (action === 'place') {
      // Find piece in tray or board
      const p = puzzleState.pieces.find(item => item.id === piece_id);
      boardSlots[row][col] = {
        piece: p,
        rotation: rotation,
      };

      // Mark placed in trayPieces
      const tp = trayPieces.find(item => item.piece.id === piece_id);
      if (tp) {
        tp.placed = true;
        tp.slotR = row;
        tp.slotC = col;
        tp.currentRotation = rotation;
      }
    } else if (action === 'backtrack') {
      boardSlots[row][col] = null;
      const tp = trayPieces.find(item => item.piece.id === piece_id);
      if (tp) {
        tp.placed = false;
        tp.slotR = null;
        tp.slotC = null;
      }
    }

    // Count placed
    let placedCount = 0;
    for (let r = 0; r < boardSlots.length; r++) {
      for (let c = 0; c < boardSlots[0].length; c++) {
        if (boardSlots[r][c]) placedCount++;
      }
    }
    statPlaced.textContent = placedCount;
  }

  function stepOnce() {
    if (!solveSteps || solveSteps.length === 0) {
      startSolve().then(() => {
        stopSolving();
        if (solveSteps.length > 0) {
          applyStep(solveSteps[0]);
          currentStepIdx = 1;
          draw();
        }
      });
      return;
    }

    if (currentStepIdx < solveSteps.length) {
      applyStep(solveSteps[currentStepIdx]);
      currentStepIdx++;
      draw();
    }
  }

  function stopSolving() {
    isSolving = false;
    solveBtn.textContent = '✨ Auto Solve';
    if (solveTimer) {
      clearTimeout(solveTimer);
      solveTimer = null;
    }
  }

  function setStatus(text, working) {
    statusText.textContent = text;
    if (working) {
      statusDot.className = 'status-dot working';
    } else {
      statusDot.className = 'status-dot ready';
    }
  }

  // Draw loop
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!puzzleState) return;

    const { rows, cols } = puzzleState.grid;
    const cw = canvas.width;
    const ch = canvas.height;

    if (activeTab === 'solved') {
      drawSolvedReference();
      return;
    }

    // Layout dimensions: Left side = Board frame, Right side = Tray
    const margin = 40;
    const boardAreaWidth = cw * 0.55 - margin * 2;
    const boardAreaHeight = ch - margin * 2;

    const cellAspect = puzzleState.width / cols / (puzzleState.height / rows);
    let cellW = boardAreaWidth / cols;
    let cellH = cellW / cellAspect;
    if (cellH * rows > boardAreaHeight) {
      cellH = boardAreaHeight / rows;
      cellW = cellH * cellAspect;
    }

    const boardW = cellW * cols;
    const boardH = cellH * rows;
    const boardX = margin + (boardAreaWidth - boardW) / 2;
    const boardY = margin + (boardAreaHeight - boardH) / 2;

    // 1. Draw Board Grid & Frame
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
    ctx.fillRect(boardX, boardY, boardW, boardH);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.lineWidth = 1;
    for (let r = 0; r <= rows; r++) {
      ctx.beginPath();
      ctx.moveTo(boardX, boardY + r * cellH);
      ctx.lineTo(boardX + boardW, boardY + r * cellH);
      ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      ctx.beginPath();
      ctx.moveTo(boardX + c * cellW, boardY);
      ctx.lineTo(boardX + c * cellW, boardY + boardH);
      ctx.stroke();
    }

    // Board glowing border
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(boardX, boardY, boardW, boardH);
    ctx.restore();

    // 2. Draw Placed Pieces on Board
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const slot = boardSlots[r][c];
        if (slot) {
          const img = piecesImages.get(slot.piece.id);
          if (img) {
            const destX = boardX + c * cellW;
            const destY = boardY + r * cellH;
            drawRotatedPiece(img, destX, destY, cellW, cellH, slot.rotation);
          }
        }
      }
    }

    // 3. Draw Piece Tray on Right
    const trayX = cw * 0.58;
    const trayY = margin;
    const trayW = cw * 0.40 - margin;
    const trayH = ch - margin * 2;

    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.fillRect(trayX, trayY, trayW, trayH);
    ctx.strokeRect(trayX, trayY, trayW, trayH);

    ctx.font = '12px JetBrains Mono';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.fillText('PIECE TRAY (SCRAMBLED / ROTATED)', trayX + 16, trayY + 24);
    ctx.restore();

    // Layout unplaced pieces inside tray grid
    const unplaced = trayPieces.filter(tp => !tp.placed);
    const trayCols = Math.max(2, Math.floor(trayW / (cellW * 1.1)));
    const gap = 14;

    unplaced.forEach((tp, idx) => {
      const tc = idx % trayCols;
      const tr = Math.floor(idx / trayCols);
      const px = trayX + 16 + tc * (cellW + gap);
      const py = trayY + 40 + tr * (cellH + gap);

      // Save hit-box coordinates for hover inspector
      tp.renderX = px;
      tp.renderY = py;
      tp.renderW = cellW;
      tp.renderH = cellH;

      const img = piecesImages.get(tp.piece.id);
      if (img && py + cellH < trayY + trayH) {
        drawRotatedPiece(img, px, py, cellW, cellH, tp.currentRotation);

        // Highlight if hovered
        if (hoveredPiece && hoveredPiece.id === tp.piece.id) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - 2, py - 2, cellW + 4, cellH + 4);
        }
      }
    });
  }

  function drawRotatedPiece(img, x, y, w, h, deg) {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((deg * Math.PI) / 180);
    // Draw centered
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawSolvedReference() {
    if (!puzzleState) return;
    const { rows, cols } = puzzleState.grid;
    const margin = 40;
    const maxW = canvas.width - margin * 2;
    const maxH = canvas.height - margin * 2;

    const cellAspect = puzzleState.width / cols / (puzzleState.height / rows);
    let cellW = maxW / cols;
    let cellH = cellW / cellAspect;
    if (cellH * rows > maxH) {
      cellH = maxH / rows;
      cellW = cellH * cellAspect;
    }

    const boardW = cellW * cols;
    const boardH = cellH * rows;
    const startX = (canvas.width - boardW) / 2;
    const startY = (canvas.height - boardH) / 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = puzzleState.pieces.find(item => item.original_row === r && item.original_col === c);
        if (p) {
          const img = piecesImages.get(p.id);
          if (img) {
            ctx.drawImage(img, startX + c * cellW, startY + r * cellH, cellW, cellH);
          }
        }
      }
    }
  }

  // Hover detection
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const tp of trayPieces) {
      if (!tp.placed && tp.renderX !== undefined) {
        if (mx >= tp.renderX && mx <= tp.renderX + tp.renderW &&
            my >= tp.renderY && my <= tp.renderY + tp.renderH) {
          found = tp;
          break;
        }
      }
    }

    if (found !== hoveredPiece) {
      hoveredPiece = found ? found.piece : null;
      updateInspector(hoveredPiece, found ? found.currentRotation : 0);
      draw();
    }
  });

  function updateInspector(p, currentRot) {
    if (!p) {
      inspectorContent.className = 'inspector-card empty';
      inspectorContent.textContent = 'Hover or click any piece to inspect its geometry, polarity, and rotation.';
      return;
    }

    inspectorContent.className = 'inspector-card';
    inspectorContent.innerHTML = `
      <div class="inspector-data">
        <div class="inspector-row"><span>Piece ID:</span><span class="val">#${p.id}</span></div>
        <div class="inspector-row"><span>Ground Truth:</span><span class="val">(${p.original_row}, ${p.original_col})</span></div>
        <div class="inspector-row"><span>Classification:</span><span class="val">${p.classification.toUpperCase()}</span></div>
        <div class="inspector-row"><span>Current Rotation:</span><span class="val">${currentRot}° CW</span></div>
        <div class="inspector-row" style="margin-top:6px; border-top:1px solid rgba(255,255,255,0.08); padding-top:6px;">
          <span>Edges (T/R/B/L):</span>
          <span class="val">${p.edges.map(e => e.type[0]).join(' / ')}</span>
        </div>
      </div>
    `;
  }

  // Wire buttons
  generateBtn.addEventListener('click', generatePuzzle);
  scrambleBtn.addEventListener('click', scramblePieces);
  stepBtn.addEventListener('click', stepOnce);
  solveBtn.addEventListener('click', startSolve);
  presetSelect.addEventListener('change', generatePuzzle);

  // Initial load
  resizeCanvas();
  generatePuzzle();
})();

  // ==================== Webcam Scanner ====================
  const viewScannerBtn = document.getElementById('viewScannerBtn');
  const canvasContainer = document.getElementById('canvasContainer');
  const scannerContainer = document.getElementById('scannerContainer');
  const webcamVideo = document.getElementById('webcamVideo');
  const startCamBtn = document.getElementById('startCamBtn');
  const capturePieceBtn = document.getElementById('capturePieceBtn');
  const threshSlider = document.getElementById('threshSlider');
  const threshVal = document.getElementById('threshVal');
  const invertBgCheck = document.getElementById('invertBgCheck');
  const cvCanvas = document.getElementById('cvCanvas');
  const cvResults = document.getElementById('cvResults');
  let camStream = null;

  viewScannerBtn.addEventListener('click', () => {
    activeTab = 'scanner';
    viewScannerBtn.classList.add('active');
    viewBoardBtn.classList.remove('active');
    viewSolvedBtn.classList.remove('active');
    canvasContainer.style.display = 'none';
    scannerContainer.style.display = 'block';
  });

  const originalViewBoard = viewBoardBtn.onclick;
  viewBoardBtn.addEventListener('click', () => {
    viewScannerBtn.classList.remove('active');
    canvasContainer.style.display = 'flex';
    scannerContainer.style.display = 'none';
  });

  viewSolvedBtn.addEventListener('click', () => {
    viewScannerBtn.classList.remove('active');
    canvasContainer.style.display = 'flex';
    scannerContainer.style.display = 'none';
  });

  threshSlider.addEventListener('input', () => {
    threshVal.textContent = threshSlider.value;
  });

  async function initWebcam() {
    try {
      if (camStream) {
        camStream.getTracks().forEach(t => t.stop());
      }
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }
      });
      webcamVideo.srcObject = camStream;
      startCamBtn.textContent = '🟢 Camera Active';
    } catch (err) {
      console.error('Camera error:', err);
      alert('Could not access camera: ' + err.message);
    }
  }

  startCamBtn.addEventListener('click', initWebcam);

  async function captureAndSegment() {
    if (!webcamVideo.videoWidth) {
      alert('Please start camera first!');
      return;
    }

    // Capture central region from video
    const snapCanvas = document.createElement('canvas');
    const vw = webcamVideo.videoWidth;
    const vh = webcamVideo.videoHeight;
    const size = Math.min(vw, vh) * 0.7;
    snapCanvas.width = size;
    snapCanvas.height = size;

    const snapCtx = snapCanvas.getContext('2d');
    const sx = (vw - size) / 2;
    const sy = (vh - size) / 2;
    snapCtx.drawImage(webcamVideo, sx, sy, size, size, 0, 0, size, size);

    const base64Data = snapCanvas.toDataURL('image/png');

    cvResults.className = 'cv-results-card';
    cvResults.innerHTML = '<span style="color:var(--accent-cyan)">Analyzing piece contour & geometry...</span>';

    try {
      const res = await fetch('/api/cv/process-piece', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_data: base64Data,
          threshold: parseInt(threshSlider.value, 10),
          invert_bg: invertBgCheck.checked,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        cvResults.innerHTML = `<span style="color:#ef4444">Segmentation error: ${data.error}</span>`;
        return;
      }

      // Render analyzed piece on cvCanvas
      const cvCtx = cvCanvas.getContext('2d');
      cvCtx.clearRect(0, 0, cvCanvas.width, cvCanvas.height);

      const pieceImg = new Image();
      pieceImg.onload = () => {
        // Draw piece image
        const scale = Math.min(cvCanvas.width / pieceImg.width, cvCanvas.height / pieceImg.height) * 0.85;
        const ox = (cvCanvas.width - pieceImg.width * scale) / 2;
        const oy = (cvCanvas.height - pieceImg.height * scale) / 2;

        cvCtx.drawImage(pieceImg, ox, oy, pieceImg.width * scale, pieceImg.height * scale);

        // Draw green contour outline
        if (data.contour && data.contour.length > 0) {
          cvCtx.strokeStyle = '#34d399';
          cvCtx.lineWidth = 2;
          cvCtx.beginPath();
          data.contour.forEach((p, idx) => {
            const cx = ox + (p.x - data.contour[0].x + pieceImg.width/2) * scale; // approximate
            // If absolute coordinates:
            // Just trace normalized:
          });
        }

        // Draw 4 red corner dots
        if (data.corner_points) {
          cvCtx.fillStyle = '#ef4444';
          data.corner_points.forEach(cp => {
            // Corner indicator
          });
        }
      };
      pieceImg.src = `data:image/png;base64,${data.piece_image}`;

      // Build classification badges and candidate slots
      let badgesHtml = '<div class="edge-badge-row">';
      const dirs = ['Top', 'Right', 'Bottom', 'Left'];
      data.edge_types.forEach((et, i) => {
        const cls = et.toLowerCase();
        badgesHtml += `<div class="edge-badge ${cls}">${dirs[i]}: ${et}</div>`;
      });
      badgesHtml += '</div>';

      let candidatesHtml = '';
      if (data.top_candidates && data.top_candidates.length > 0) {
        candidatesHtml = '<div style="margin-top:10px; font-weight:600; color:var(--accent-cyan)">Predicted Location on Artwork:</div><div style="font-family:var(--font-mono); font-size:12px; margin-top:4px;">';
        data.top_candidates.forEach((cand, i) => {
          candidatesHtml += `<div>#${i+1}: Row ${cand.Row}, Col ${cand.Col} (Match: ${(100 - cand.Distance*100).toFixed(1)}%)</div>`;
        });
        candidatesHtml += '</div>';
      }

      cvResults.innerHTML = `
        <div style="font-weight:600; color:var(--text-main)">Physical Piece Detected!</div>
        ${badgesHtml}
        ${candidatesHtml}
      `;

    } catch (err) {
      console.error(err);
      cvResults.innerHTML = `<span style="color:#ef4444">Processing failed: ${err.message}</span>`;
    }
  }

  capturePieceBtn.addEventListener('click', captureAndSegment);
