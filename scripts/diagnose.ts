/**
 * 実スキャン画像に対する検出診断（数値のみを出力する）。
 *
 * 画像の内容そのものは一切出力しない。個人情報を会話やログへ載せないため、
 * 出力するのは寸法・座標・統計量に限る。
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createDetectionProxy, readHeader } from '@worker/imageIo';
import {
  adaptiveThreshold,
  borderRingIndices,
  computeDeltaE,
  estimateBackgroundLab,
  detectCard,
} from '@worker/detector';
import { loadOpenCv, withMats, cvConstant } from '@worker/opencv';
import { areaScore, aspectScore, rectangularity, scoreCandidate } from '@core/detect/scoring';
import { warpTargetSize, quadToArray } from '@core/geometry/quad';
import { normalizeDpi, physicalSize } from '@core/dpi/dpi';

const dir = process.env.SCAN_DIR!;
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|tiff?)$/i.test(f));

for (const [index, name] of files.entries()) {
  const file = path.join(dir, name);
  // ファイル名も個人情報になりうるため、通し番号で呼ぶ。
  const label = `画像${index + 1}`;
  console.log(`\n=== ${label} ===`);

  const header = await readHeader(file);
  console.log(
    `  寸法: ${header.width} x ${header.height} px (${((header.width * header.height) / 1e6).toFixed(1)} Mpx)`,
  );
  console.log(
    `  DPI: ${header.density ?? 'なし'} / 形式: ${header.format} / alpha: ${header.hasAlpha}`,
  );
  console.log(`  サイズ: ${(header.fileBytes / 1024 / 1024).toFixed(1)} MB`);

  const proxy = await createDetectionProxy(file);
  console.log(
    `  プロキシ: ${proxy.width} x ${proxy.height} (scale ${proxy.scaleToOriginal.toFixed(3)})`,
  );

  const cv = await loadOpenCv();
  withMats((track) => {
    const src = track(new cv.Mat(proxy.height, proxy.width, cv.CV_8UC3));
    src.data.set(proxy.data);
    const lab = track(new cv.Mat());
    cv.cvtColor(src, lab, cvConstant(cv.COLOR_RGB2Lab, 'x'));

    const ring = borderRingIndices(proxy.width, proxy.height);
    const bg = estimateBackgroundLab(lab.data, proxy.width, proxy.height);
    const de = computeDeltaE(lab.data, proxy.width * proxy.height, bg);
    const th = adaptiveThreshold(de, ring);
    let above = 0;
    for (const v of de) if (v > th) above++;
    console.log(
      `  背景Lab: L=${bg.l} a=${bg.a} b=${bg.b} / 閾値: ${th.toFixed(1)} / マスク被覆率: ${((above / de.length) * 100).toFixed(1)}%`,
    );

    const mask = track(new cv.Mat(proxy.height, proxy.width, cv.CV_8UC1));
    for (let i = 0; i < de.length; i++) mask.data[i] = de[i]! > th ? 255 : 0;
    const k5 = track(cv.getStructuringElement(cvConstant(cv.MORPH_RECT, 'x'), new cv.Size(5, 5)));
    const k3 = track(cv.getStructuringElement(cvConstant(cv.MORPH_RECT, 'x'), new cv.Size(3, 3)));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k5);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k3);

    const contours = track(new cv.MatVector());
    const hier = track(new cv.Mat());
    cv.findContours(
      mask,
      contours,
      hier,
      cvConstant(cv.RETR_EXTERNAL, 'x'),
      cvConstant(cv.CHAIN_APPROX_SIMPLE, 'x'),
    );

    const imageArea = proxy.width * proxy.height;
    const rows: string[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area >= imageArea * 0.005) {
        const r = cv.minAreaRect(c);
        const long = Math.max(r.size.width, r.size.height);
        const short = Math.min(r.size.width, r.size.height);
        const m = {
          contourArea: area,
          minAreaRectArea: r.size.width * r.size.height,
          aspectRatio: long / short,
          imageArea,
          edgeTouchCount: 0,
        };
        // approxPolyDP が何点になるかも見る（角の丸みで 4 点にならないことがある）
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
        rows.push(
          `    輪郭#${i}: 面積比=${(area / imageArea).toFixed(3)} 矩形度=${rectangularity(m).toFixed(3)} アスペクト=${m.aspectRatio.toFixed(3)}(${aspectScore(m.aspectRatio).toFixed(2)}) 面積スコア=${areaScore(m).toFixed(2)} 傾き=${r.angle.toFixed(1)}度 approx点数=${approx.rows} => score=${scoreCandidate(m).toFixed(3)}`,
        );
        approx.delete();
      }
      c.delete();
    }
    console.log(`  輪郭数: ${contours.size()}（面積比0.5%以上のもの ${rows.length} 件）`);
    for (const r of rows) console.log(r);
    return null;
  });

  const result = await detectCard(proxy, proxy.scaleToOriginal);
  console.log(
    `  検出: ${result.status} conf=${result.confidence.toFixed(3)} 複数候補=${result.hasMultipleCandidates}`,
  );
  if (result.quad !== null) {
    const pts = quadToArray(result.quad);
    console.log(
      `  四隅(原寸): ${pts.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' ')}`,
    );
    const size = warpTargetSize(result.quad);
    const dpi = normalizeDpi(header.density);
    const mm = physicalSize(size, dpi.effectiveDpi);
    console.log(
      `  切出しサイズ: ${size.width} x ${size.height} px = ${mm.widthMm.toFixed(1)} x ${mm.heightMm.toFixed(1)} mm (適用DPI ${dpi.effectiveDpi})`,
    );
    console.log(
      `  ID-1実寸との差: 幅 ${(mm.widthMm - 85.6).toFixed(1)}mm / 高さ ${(mm.heightMm - 54.0).toFixed(1)}mm`,
    );
  }
}
