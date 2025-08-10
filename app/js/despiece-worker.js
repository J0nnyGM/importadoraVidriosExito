// Contenido para: despiece-worker.js

/**
 * --- MOTOR DE BÚSQUEDA EXHAUSTIVA (v17 - Basado en exhaustive_guillotine_packer.js) ---
 *
 * Este script contiene el algoritmo de despiece de alta precisión proporcionado
 * por el usuario, adaptado para un entorno web.
 *
 * LÓGICA CLAVE:
 * - Utiliza un sistema de "rectángulos libres" para una gestión del espacio
 * geométricamente correcta, previniendo superposiciones.
 * - Intenta una solución óptima para una lámina mediante backtracking con
 * límite de tiempo (`tryPackIntoOneSheet`).
 * - Si la búsqueda exhaustiva no logra colocar todas las piezas, recurre a un
 * método "greedy" (`greedyPackAsMany`) para llenar la lámina actual y
 * continuar con las restantes, garantizando una solución robusta.
 *
 * Adaptado por: Gemini
 */

// --- CLASES Y LÓGICA DEL ALGORITMO PROPORCIONADO ---

class Piece {
  constructor(id, w, h, rotatable = true) {
    this.id = id;
    this.w = w;
    this.h = h;
    this.rotatable = rotatable;
    this.area = w * h;
  }
  clone() { return new Piece(this.id, this.w, this.h, this.rotatable); }
}

class Rect {
  constructor(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; }
  area() { return this.w * this.h; }
  contains(r) { return this.x <= r.x && this.y <= r.y && this.x + this.w >= r.x + r.w && this.y + this.h >= r.y + r.h; }
}

function splitFreeRect(fr, placed, kerf = 0) {
  const newRects = [];
  const px = placed.x, py = placed.y, pw = placed.w, ph = placed.h;
  const k = kerf;

  // Rectángulo derecho
  const rightW = fr.w - pw - k;
  if (rightW > 0) {
    newRects.push(new Rect(px + pw + k, py, rightW, fr.h));
  }
  // Rectángulo inferior
  const bottomH = fr.h - ph - k;
  if (bottomH > 0) {
    newRects.push(new Rect(px, py + ph + k, pw, bottomH));
  }
  return newRects;
}

function pruneFreeList(freeRects) {
  const clean = freeRects.filter(r => r.w > 0 && r.h > 0);
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    let contained = false;
    for (let j = 0; j < clean.length; j++) {
      if (i !== j && clean[j].contains(clean[i])) { contained = true; break; }
    }
    if (!contained) out.push(clean[i]);
  }
  return out;
}

function greedyPlaceOne(freeRects, piece, allowRotate, kerf) {
  let best = null;
  for (let fi = 0; fi < freeRects.length; fi++) {
    const fr = freeRects[fi];
    const options = [[piece.w, piece.h, false]];
    if (allowRotate && piece.rotatable && piece.w !== piece.h) options.push([piece.h, piece.w, true]);

    for (const [pw, ph, rotated] of options) {
      if (pw <= fr.w && ph <= fr.h) {
        const waste = fr.area() - pw * ph;
        if (!best || waste < best.waste) {
          best = { fi, pw, ph, rotated, waste, fr };
        }
      }
    }
  }
  if (!best) return null;
  const placedRect = new Rect(best.fr.x, best.fr.y, best.pw, best.ph);
  return { placedRect, rotated: best.rotated, freeIndex: best.fi };
}

function tryPackAll(pieces, sheetW, sheetH, kerf, timeLimitMs) {
  const start = Date.now();
  const timeLimit = start + (timeLimitMs || 2000);
  const piecesClone = pieces.map(p => p.clone());
  piecesClone.sort((a, b) => b.area - a.area);
  const initialFree = [new Rect(0, 0, sheetW, sheetH)];

  function recurse(idx, freeRects) {
    if (Date.now() > timeLimit) return null;
    if (idx >= piecesClone.length) return [];

    const piece = piecesClone[idx];
    const allowRotate = true;
    const frOrder = freeRects.map((r, i) => ({ r, i })).sort((a, b) => a.r.area() - b.r.area());

    for (const { r: fr, i: fi } of frOrder) {
      const options = [[piece.w, piece.h, false]];
      if (allowRotate && piece.rotatable && piece.w !== piece.h) options.push([piece.h, piece.w, true]);

      for (const [pw, ph, rotated] of options) {
        if (pw <= fr.w && ph <= fr.h) {
          const placed = new Rect(fr.x, fr.y, pw, ph);
          const newFree = [...freeRects.slice(0, fi), ...freeRects.slice(fi + 1)];
          const splits = splitFreeRect(fr, placed, kerf);
          newFree.push(...splits);
          const pruned = pruneFreeList(newFree);
          const res = recurse(idx + 1, pruned);
          if (res !== null) {
            res.unshift({ piece: piece.clone(), rect: placed, rotated });
            return res;
          }
        }
      }
    }
    return null;
  }
  return recurse(0, initialFree);
}

function greedyPackAsMany(pieces, sheetW, sheetH, kerf) {
  const remaining = pieces.map(p => p.clone());
  const placedList = [];
  let freeRects = [new Rect(0, 0, sheetW, sheetH)];
  remaining.sort((a, b) => b.area - a.area);

  let pieceIndex = 0;
  while(pieceIndex < remaining.length){
      const piece = remaining[pieceIndex];
      const best = greedyPlaceOne(freeRects, piece, true, kerf);
      
      if(best){
          const fr = freeRects.splice(best.freeIndex, 1)[0];
          placedList.push({ piece: piece.clone(), rect: best.placedRect, rotated: best.rotated });
          const splits = splitFreeRect(fr, best.placedRect, kerf);
          freeRects.push(...splits);
          freeRects = pruneFreeList(freeRects);
          remaining.splice(pieceIndex, 1);
          pieceIndex = 0; // Restart scan for best fit with remaining pieces
      } else {
          pieceIndex++; // Can't fit this piece, try the next one
      }
  }
  return { placed: placedList, remaining };
}


function packExhaustive(pieces, sheetW, sheetH, kerf = 0, opts = {}) {
  const timeLimitPerSheetMs = opts.timeLimitPerSheetMs ?? 3000;
  const piecesLeft = pieces.map(p => p.clone());
  const sheets = [];

  while (piecesLeft.length > 0) {
    const attempt = tryPackAll(piecesLeft, sheetW, sheetH, kerf, timeLimitPerSheetMs);
    if (attempt && attempt.length === piecesLeft.length) {
      sheets.push({ placements: attempt });
      piecesLeft.length = 0;
      break;
    }

    const { placed, remaining } = greedyPackAsMany(piecesLeft, sheetW, sheetH, kerf);
    if (placed.length === 0) {
      if (piecesLeft.length > 0) {
        throw new Error("Algoritmo: hay una pieza que no cabe en la lámina incluso rotada: " + JSON.stringify(piecesLeft[0]));
      }
      break;
    }
    sheets.push({ placements: placed });
    
    const placedIds = new Set(placed.map(p => p.piece.id));
    for (let i = piecesLeft.length - 1; i >= 0; i--) {
        if(placedIds.has(piecesLeft[i].id)) piecesLeft.splice(i,1);
    }
  }
  return { sheets };
}

// --- ADAPTADOR Y EJECUTOR ---

self.onmessage = function(event) {
    const { anchoLamina, altoLamina, cortes, kerf } = event.data;
    let pieces = [];
    let idCounter = 1;
    cortes.forEach(c => {
        for (let i = 0; i < c.cantidad; i++) {
            pieces.push(new Piece(idCounter++, c.ancho, c.alto, true));
        }
    });

    try {
        const result = packExhaustive(pieces, anchoLamina, altoLamina, kerf, {
            timeLimitPerSheetMs: 5000 // Aumentar tiempo para búsquedas complejas
        });
        
        const finalPlano = result.sheets.map((sheet, index) => {
            const cortesEnLamina = sheet.placements.map(p => ({
                id: p.piece.id,
                ancho: p.piece.w,
                alto: p.piece.h,
                anchoFinal: p.rect.w,
                altoFinal: p.rect.h,
                x: p.rect.x,
                y: p.rect.y,
                descripcion: `${p.rect.w}x${p.rect.h}${p.rotated ? ' (R)' : ''}`,
                rotado: p.rotated
            }));
            return {
                numero: index + 1,
                cortes: cortesEnLamina
            };
        });

        const areaTotalPiezas = pieces.reduce((sum, p) => sum + p.area, 0);
        const areaTotalLaminas = finalPlano.length * anchoLamina * altoLamina;
        const aprovechamiento = (areaTotalLaminas > 0) ? (areaTotalPiezas / areaTotalLaminas) * 100 : 0;

        const output = {
            numeroLaminas: finalPlano.length,
            plano: finalPlano,
            metricas: {
                aprovechamiento: `${aprovechamiento.toFixed(2)}%`,
                laminasUsadas: finalPlano.length,
                cortesRealizados: pieces.length,
                estrategiaUsada: "Búsqueda Exhaustiva (v17)"
            }
        };
        self.postMessage({ status: 'success', resultado: output });
    } catch (error) {
        console.error("Error fatal en el Worker de Despiece:", error);
        self.postMessage({ status: 'error', message: error.message });
    }
};
