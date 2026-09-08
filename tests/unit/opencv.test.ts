import { describe, expect, it } from 'vitest';
import { loadOpenCv, withMats } from '@worker/opencv';

describe('OpenCV(WASM) の初期化', () => {
  it('ランタイムが初期化され、必要な API が使える', async () => {
    const cv = await loadOpenCv();
    expect(typeof cv.Mat).toBe('function');
    expect(typeof cv.findContours).toBe('function');
    expect(typeof cv.warpPerspective).toBe('function');
    expect(typeof cv.cvtColor).toBe('function');
  });

  it('複数回呼んでも同じインスタンスを返す', async () => {
    const [first, second] = await Promise.all([loadOpenCv(), loadOpenCv()]);
    expect(first).toBe(second);
  });

  it('モジュールを await しても停止しない（thenable を取り除いている）', async () => {
    // Emscripten のモジュールは own プロパティとして then を持つ。
    // これを残したまま値として解決すると、Promise が永久に未解決になる。
    const cv = (await loadOpenCv()) as unknown as Record<string, unknown>;
    expect(typeof cv.then).not.toBe('function');
  });
});

describe('Mat の解放', () => {
  it('処理後に Mat が解放される', async () => {
    const cv = await loadOpenCv();
    let captured: { isDeleted: () => boolean } | null = null;

    withMats((track) => {
      captured = track(new cv.Mat(4, 4, cv.CV_8UC1));
      return null;
    });

    expect(captured).not.toBeNull();
    expect(captured!.isDeleted()).toBe(true);
  });

  it('例外が起きても Mat が解放される', async () => {
    const cv = await loadOpenCv();
    let captured: { isDeleted: () => boolean } | null = null;

    expect(() =>
      withMats((track) => {
        captured = track(new cv.Mat(4, 4, cv.CV_8UC1));
        throw new Error('意図的な失敗');
      }),
    ).toThrow('意図的な失敗');

    expect(captured!.isDeleted()).toBe(true);
  });
});
