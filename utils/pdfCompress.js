// Compression PDF via Ghostscript (ré-échantillonnage des images), au dépôt d'un
// support. Objectif : réduire le stockage ET faire repasser les gros scans sous la
// limite PDF de l'API Claude (~32 Mo), SANS dégrader la lisibilité OCR.
// 150 dpi (/ebook) = le point d'équilibre : net pour l'OCR et calé sur la résolution
// que Claude exploite réellement (il redimensionne chaque page vers ~1568 px de côté).
// Toujours non bloquant : si Ghostscript échoue ou ne gagne rien, on garde l'original.
const { execFile } = require('child_process');
const fs = require('fs');

const IA_LIMIT = 32 * 1024 * 1024;       // au-delà, l'IA ne peut pas traiter le PDF
const MIN_TO_COMPRESS = 8 * 1024 * 1024; // en dessous, inutile de compresser
const GS_TIMEOUT_MS = 120000;

// Lance Ghostscript pour ré-échantillonner à `dpi`. execFile (pas de shell) → pas
// d'injection ; le chemin d'entrée est un nom généré côté serveur.
function runGs(input, output, dpi) {
  return new Promise((resolve, reject) => {
    execFile(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.5',
        '-dPDFSETTINGS=/ebook',
        '-dDownsampleColorImages=true', `-dColorImageResolution=${dpi}`,
        '-dDownsampleGrayImages=true', `-dGrayImageResolution=${dpi}`,
        '-dDownsampleMonoImages=true', `-dMonoImageResolution=${dpi * 2}`,
        '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER',
        `-sOutputFile=${output}`,
        input,
      ],
      { timeout: GS_TIMEOUT_MS },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

/**
 * Compresse le PDF SUR PLACE si c'est utile. Renvoie la taille finale (octets).
 * Écrase `filePath` par la version compressée uniquement si elle est plus petite.
 */
async function compressPdfInPlace(filePath, originalSize) {
  if (!originalSize || originalSize < MIN_TO_COMPRESS) return originalSize;

  const tmp = `${filePath}.gs.pdf`;
  try {
    await runGs(filePath, tmp, 150);
    let outSize = fs.statSync(tmp).size;

    // Repli adaptatif : si à 150 dpi on dépasse encore la limite IA, un essai à 120 dpi.
    if (outSize > IA_LIMIT) {
      const tmp2 = `${filePath}.gs2.pdf`;
      try {
        await runGs(filePath, tmp2, 120);
        const outSize2 = fs.statSync(tmp2).size;
        if (outSize2 < outSize) { fs.renameSync(tmp2, tmp); outSize = outSize2; }
        else safeUnlink(tmp2);
      } catch (e) {
        safeUnlink(tmp2);
        console.warn('[pdf] repli 120 dpi ignoré:', e.message);
      }
    }

    if (outSize < originalSize) {
      fs.renameSync(tmp, filePath); // écrase l'original par le compressé
      return outSize;
    }
    safeUnlink(tmp); // Ghostscript n'a rien gagné → on garde l'original
    return originalSize;
  } catch (e) {
    safeUnlink(tmp);
    console.warn('[pdf] compression ignorée (garde l’original):', e.message);
    return originalSize;
  }
}

module.exports = { compressPdfInPlace };
